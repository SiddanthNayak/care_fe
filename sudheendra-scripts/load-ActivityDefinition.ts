import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Import other loaders lazily inside main to avoid loading dependencies when
// skip-insert flags are used.
import {
  type BaseConfig,
  type ProcessedRow,
  type ValidationRule,
  colorize,
  createScriptConfig,
  ensureActivityDefinitionCategories,
  ensureAuthentication,
  fetchCsvFromGoogleSheet,
  generateHashSlug,
  getAuthHeaders,
  getLogger,
  loadData,
  makeBatchApiCall,
  mapResultsToOutput,
  mergeConfigWithCli,
  normalizeTitle,
  parseCliArgs,
  parseCode,
  processApiResults,
  removeDuplicates,
  showCliHelp,
  transformCsvToObjects,
  validateRowCodes,
  writeOutputCsv,
} from "./utils.js";

type Status = "draft" | "active" | "retired" | "unknown";
type Classification =
  | "laboratory"
  | "imaging"
  | "surgical_procedure"
  | "counselling";
type Kind = "service_request";

interface Code {
  system: string;
  code: string;
  display: string;
}

interface ActivityDefinitionCreateSpec {
  title: string;
  slug_value: string;
  description: string;
  usage: string;
  status: Status;
  classification: Classification;
  kind: Kind;
  facility: string;
  category: string;
  specimen_requirements: string[];
  charge_item_definitions: string[];
  observation_result_requirements: string[];
  locations: string[];
  diagnostic_report_codes: Code[];
  code: Code;
  body_site: Code | null;
  derived_from_uri: string | null;
  healthcare_service: string | null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.join(path.dirname(__filename), "inputs");
const __rootDir = path.join(__dirname, "..");

dotenv.config({
  path: [path.join(__rootDir, ".env.local"), path.join(__rootDir, ".env")],
});

const logger = getLogger();

interface ActivityData {
  title: string;
  slug_value: string;
  description: string;
  usage: string;
  status: Status;
  classification: Classification;
  kind: Kind;
  category: string; // Category slug for creation
  observations: string[];
  specimens: string[];
  chargeItems: string[];
  diagnostic_report_loinc_codes: Code[];
  code?: Code;
  body_site?: Code;
  derived_from_uri?: string;
  locations?: string[];
  healthcare_service?: string;
}

interface LoaderResult {
  successful: unknown[];
  failed?: unknown[];
  results?: unknown[];
}

const extractSlugValue = (entry: unknown): string | null => {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const value = entry as {
    slug_value?: string;
    item?: { slug_value?: string };
  };
  return value.slug_value ?? value.item?.slug_value ?? null;
};

// Function to lookup missing codes using ValueSet API
async function lookupCode(
  searchTerm: string,
  config: BaseConfig,
): Promise<Code | null> {
  try {
    const { fetchWithTokenRetry } = await import("./utils.js");
    const response = await fetchWithTokenRetry(
      `${config.apiBaseUrl}/api/v1/valueset/activity-definition-procedure-code/expand/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(config),
        },
        body: JSON.stringify({
          count: 10,
          search: searchTerm,
        }),
      },
      config,
    );

    if (!response.ok) {
      logger(
        colorize(
          `Failed to lookup code for "${searchTerm}": ${response.status} ${response.statusText}`,
          1,
        ),
      );
      return null;
    }

    const data = await response.json();

    // Check if we have results
    if (data.expansion?.contains && data.expansion.contains.length > 0) {
      const firstResult = data.expansion.contains[0];
      return {
        system: firstResult.system || "http://snomed.info/sct",
        code: firstResult.code,
        display: firstResult.display,
      };
    }

    return null;
  } catch (error) {
    logger(colorize(`Error looking up code for "${searchTerm}": ${error}`, 1));
    return null;
  }
}

// Script-specific configuration defaults
const SCRIPT_DEFAULTS = {
  inputFile: path.join(__dirname, "ActivityDefinition.csv"),
  outputFile: path.join(__dirname, "output", "ActivityDefinitions-output.csv"),
  outputDir: path.join(__dirname, "output"),
};

const SHEET_HEADER_MAP = {
  category: "category",
  title: "title",
  slug_value: "slug_value",
  description: "description",
  usage: "usage",
  status: null,
  classification: "classification",
  code_value: "code_value",
  code_display: "code_display",
  code_system: "code_system",
  diagnostic_report_loinc_codes: "diagnostic_report_codes",
  diagnostic_report_display: "diagnostic_report_display",
  diagnostic_report_system: "diagnostic_report_system",
  specimen_slugs: "specimen_slugs",
  observation_slugs: "observation_slugs",
  charge_item_slugs: "charge_item_slugs",
  healthcare_service: "healthcare_service",
  locations: "locations",
  body_site_system: null,
  body_site_code: null,
  body_site_display: null,
  derived_from_uri: null,
};

async function loadActivityRows(
  config: BaseConfig,
): Promise<Record<string, string>[]> {
  if (config.parser !== "google-sheets") {
    return loadData(config);
  }

  if (!config.googleSheetId || !config.sheetName) {
    throw new Error(
      "Google Sheets parser requires googleSheetId and sheetName",
    );
  }

  const csvData = await fetchCsvFromGoogleSheet(
    config.googleSheetId,
    config.sheetName,
  );

  return transformCsvToObjects(csvData, SHEET_HEADER_MAP);
}

// Validation rules for activity definition codes
const ACTIVITY_VALIDATION_RULES: ValidationRule[] = [
  {
    rowPrefix: "code",
    valuesetUrl:
      "/api/v1/valueset/activity-definition-procedure-code/validate_code/",
    defaultCode: "71388002", // Default procedure code
    defaultSystem: "http://snomed.info/sct",
    defaultDisplay: "Procedure",
    batchSize: 20,
  },
  // You can easily add more validation rules here:
  // {
  //   rowPrefix: "body_site",
  //   valuesetUrl: "/api/v1/valueset/body-site/validate_codes/",
  //   defaultCode: "123456789",
  //   defaultSystem: "http://snomed.info/sct",
  //   defaultDisplay: "Test Body Site",
  //   batchSize: 20,
  // },
];

// Helper function to create ActivityData from a row with validated code
function createActivityDataFromRow(row: Record<string, string>): ActivityData {
  // Create code from validated row data

  let rowCode = row.code_value;
  if (rowCode && rowCode.includes(",")) {
    rowCode = rowCode.split(",")[0];
  }
  const finalCode = {
    system: row.code_system || ACTIVITY_VALIDATION_RULES[0].defaultSystem,
    code: rowCode || ACTIVITY_VALIDATION_RULES[0].defaultCode,
    display: row.code_display || ACTIVITY_VALIDATION_RULES[0].defaultDisplay,
  };
  const bodySite = parseCode(
    row.body_site_system,
    row.body_site_code,
    row.body_site_display,
  );

  // Parse diagnostic report LOINC codes as Code objects
  const diagnosticReportCodes: Code[] = [];
  if (row.diagnostic_report_loinc_codes) {
    const codes = row.diagnostic_report_loinc_codes
      .split(";")
      .map((s: string) => s.trim())
      .filter((s: string) => s);

    for (const codeStr of codes) {
      // Default to LOINC system if no system specified
      const code = parseCode("http://loinc.org", codeStr, codeStr);
      if (code) {
        diagnosticReportCodes.push({
          system: code.system,
          code: code.code,
          display: code.display,
        });
      }
    }
  }

  return {
    title: row.title,
    slug_value: generateHashSlug(normalizeTitle(row.title)),
    description: row.description,
    usage: row.usage || "",
    status: (row.status as Status) || "active",
    classification: (row.classification as Classification) || "laboratory",
    kind: "service_request",
    category: row.category || "laboratory",
    observations: row.observation_slugs
      ? row.observation_slugs
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s)
      : [],
    specimens: row.specimen_slugs
      ? row.specimen_slugs
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s)
      : [],
    chargeItems: row.charge_item_slugs
      ? row.charge_item_slugs
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s)
      : [],
    diagnostic_report_loinc_codes: [], //diagnosticReportCodes,
    code: finalCode,
    body_site: bodySite || undefined,
    derived_from_uri: row.derived_from_uri || undefined,
    locations: row.locations
      ? row.locations
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s)
      : [],
    healthcare_service: row.healthcare_service?.trim() || undefined,
  };
}

// Function to process CSV data using flexible validation
async function processCsvData(
  rows: Record<string, string>[],
  config: BaseConfig,
): Promise<{ data: ActivityData[]; substitutions: Map<string, string> }> {
  // Validate codes using the flexible validation system
  const { validatedRows, substitutions } = await validateRowCodes(
    rows,
    config,
    ACTIVITY_VALIDATION_RULES,
  );

  // Process validated rows into ActivityData
  const results: ActivityData[] = [];
  for (const row of validatedRows) {
    try {
      if (!row.title || !row.title.trim()) {
        logger(colorize("Skipping row with empty title", 1));
        continue;
      }
      const activityData = createActivityDataFromRow(row);
      results.push(activityData);
    } catch (error: any) {
      logger(
        colorize(`Error processing row "${row.title}": ${error.message}`, 1),
      );
    }
  }

  /*   const locationData = await fetchLocationData(
    Array.from(new Set(results.map((result) => result.locations || []).flat())),
    config,
  );

  const locationDataMap = new Map(
    locationData.map((location) => [location.name, location.id]),
  );

  results.forEach((result) => {
    let locationIds: string[] = [];
    result.locations?.forEach((locationName) => {
      const locationId = locationDataMap.get(locationName);
      if (locationId) {
        locationIds.push(locationId);
      }
    });
    result.locations = locationIds;
  }); */

  return { data: results, substitutions };
}

// Removed checkDependencies function - dependency checking is now done inline
// with selective filtering of missing dependencies rather than blocking entire activities

// Main function
async function main(configOverride?: Partial<BaseConfig>) {
  let finalConfig = configOverride
    ? createScriptConfig(
        SCRIPT_DEFAULTS.inputFile,
        SCRIPT_DEFAULTS.outputFile,
        configOverride,
      )
    : mergeConfigWithCli(
        createScriptConfig(
          SCRIPT_DEFAULTS.inputFile,
          SCRIPT_DEFAULTS.outputFile,
        ),
      );

  try {
    logger(colorize("Starting activity definition loader...", 0));

    // Ensure authentication tokens are available if token auth is enabled
    const authenticatedConfig = await ensureAuthentication(finalConfig);
    finalConfig = { ...finalConfig, ...authenticatedConfig };

    // Step 0: Create output directory if it doesn't exist
    const outputDir = SCRIPT_DEFAULTS.outputDir;
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Step 1: Load dependencies first
    logger(colorize("\n=== Loading Dependencies ===", 0));

    const skipChargeItems = finalConfig.skipInsert?.includes("cid") || false;
    const skipSpecimens = finalConfig.skipInsert?.includes("sm") || false;
    const skipObservations = finalConfig.skipInsert?.includes("obs") || false;

    let chargeItemResults: LoaderResult = { successful: [] };
    let specimenResults: LoaderResult = { successful: [] };
    let observationResults: LoaderResult = { successful: [] };

    // Load charge items
    if (skipChargeItems) {
      logger(colorize("Skipping charge item loading...", 1));
    } else {
      logger(colorize("Loading charge items...", 2));
      const { main: loadChargeItems } = await import("./load-chargeItem.js");
      chargeItemResults = await loadChargeItems({
        ...authenticatedConfig,
        inputFile: path.join(__dirname, "ChargeItemDefinition.csv"),
        outputFile: path.join(outputDir, "ChargeItems-output.csv"),
        facilityId: finalConfig.facilityId,
        apiBaseUrl: finalConfig.apiBaseUrl,
        parser: finalConfig.parser,
        googleSheetId: finalConfig.googleSheetId,
        sheetName: finalConfig.sheetName,
      });
    }

    // Load specimens
    if (skipSpecimens) {
      logger(colorize("Skipping specimen loading...", 1));
    } else {
      logger(colorize("Loading specimens...", 2));
      const { main: loadSpecimens } =
        await import("./load-specimenDefinition.js");
      specimenResults = await loadSpecimens({
        ...authenticatedConfig,
        inputFile: path.join(__dirname, "SpecimenDefinition.csv"),
        outputFile: path.join(outputDir, "Specimens-output.csv"),
        facilityId: finalConfig.facilityId,
        apiBaseUrl: finalConfig.apiBaseUrl,
        parser: finalConfig.parser,
        googleSheetId: finalConfig.googleSheetId,
        sheetName: finalConfig.sheetName,
      });
    }

    // Load observations
    if (skipObservations) {
      logger(colorize("Skipping observation loading...", 1));
    } else {
      logger(colorize("Loading observations...", 2));
      const { main: loadObservations } =
        await import("./load-observation_definition.js");
      observationResults = await loadObservations({
        ...authenticatedConfig,
        inputFile: path.join(__dirname, "ObservationDefinition.csv"),
        outputFile: path.join(outputDir, "Observations-output.csv"),
        facilityId: finalConfig.facilityId,
        apiBaseUrl: finalConfig.apiBaseUrl,
        parser: finalConfig.parser,
        googleSheetId: finalConfig.googleSheetId,
        sheetName: finalConfig.sheetName,
      });
    }

    // Step 2: Check if input file exists (only for local parser)
    if (
      finalConfig.parser === "local" &&
      !fs.existsSync(finalConfig.inputFile)
    ) {
      throw new Error(`Input file not found: ${finalConfig.inputFile}`);
    }

    // Step 3: Load activity definitions
    logger(colorize("\n=== Loading Activity Definitions ===", 0));
    logger(colorize("Loading data...", 0));
    const csvRows = await loadActivityRows(finalConfig);

    if (csvRows.length === 0) {
      throw new Error("No valid rows found in CSV file");
    }

    // Process data
    logger(colorize("Processing data...", 0));
    const { data: processedData, substitutions } = await processCsvData(
      csvRows,
      finalConfig,
    );

    const categoryData = processedData.map((item) => item.category);

    // Step 4: Ensure categories exist
    logger(colorize("Ensuring categories exist...", 0));
    const categoryResults = await ensureActivityDefinitionCategories(
      categoryData,
      finalConfig,
    );

    // Create a map of category title -> slug for replacement
    const categoryMap = new Map<string, string>();
    categoryResults.categoryData.forEach((cat) => {
      // Use the title as is for the map key
      categoryMap.set(cat.title, cat.slug_value);
    });

    // Remove duplicates
    const uniqueProcessedData = removeDuplicates(processedData);

    // Replace category values with actual generated slugs
    uniqueProcessedData.forEach((item) => {
      const categorySlug = categoryMap.get(normalizeTitle(item.category));
      if (categorySlug) {
        item.category = categorySlug;
      }
    });

    // Create output data for CSV
    let outputData: ProcessedRow[] = uniqueProcessedData.map((item) => ({
      ...item,
      slug_value: item.slug_value,
      status: "Pending",
      code_substitution: substitutions.get(item.slug_value) || "",
    }));

    // Step 4: Check dependencies and prepare for batch processing
    logger(colorize("Checking dependencies and preparing for upsert...", 0));
    const allActivities: ActivityData[] = [];
    const invalidActivities: { item: ActivityData; error: string }[] = [];
    const activityWarnings: Map<string, string[]> = new Map();

    const uniqueStrings = (values: string[]) =>
      Array.from(new Set(values)).filter((value) => value);

    const csvChargeItems = uniqueStrings(
      uniqueProcessedData.flatMap((item) => item.chargeItems),
    );
    const csvSpecimens = uniqueStrings(
      uniqueProcessedData.flatMap((item) => item.specimens),
    );
    const csvObservations = uniqueStrings(
      uniqueProcessedData.flatMap((item) => item.observations),
    );

    const availableSlugs = {
      observations: skipObservations
        ? csvObservations
        : uniqueStrings(
            observationResults.successful
              .map(extractSlugValue)
              .filter((slug): slug is string => Boolean(slug)),
          ),
      specimens: skipSpecimens
        ? csvSpecimens
        : uniqueStrings(
            specimenResults.successful
              .map(extractSlugValue)
              .filter((slug): slug is string => Boolean(slug)),
          ),
      chargeItems: skipChargeItems
        ? csvChargeItems
        : uniqueStrings(
            chargeItemResults.successful
              .map(extractSlugValue)
              .filter((slug): slug is string => Boolean(slug)),
          ),
      categories: categoryResults.successful,
    };

    for (const item of uniqueProcessedData) {
      const warnings: string[] = [];

      // Check if category is missing (critical - blocks creation)
      if (!availableSlugs.categories.includes(item.category)) {
        invalidActivities.push({
          item,
          error: `Missing category: ${item.category}`,
        });
        continue; // Skip this activity entirely
      }

      // Check for missing dependencies (non-critical - just warnings)
      const missingObservations = item.observations.filter(
        (obs) => !availableSlugs.observations.includes(obs),
      );
      const missingSpecimens = item.specimens.filter(
        (spec) => !availableSlugs.specimens.includes(spec),
      );
      const missingChargeItems = item.chargeItems.filter(
        (ci) => !availableSlugs.chargeItems.includes(ci),
      );

      if (missingObservations.length > 0) {
        warnings.push(
          `Missing observations: ${missingObservations.join(", ")}`,
        );
      }
      if (missingSpecimens.length > 0) {
        warnings.push(`Missing specimens: ${missingSpecimens.join(", ")}`);
      }
      if (missingChargeItems.length > 0) {
        warnings.push(`Missing charge items: ${missingChargeItems.join(", ")}`);
      }

      if (warnings.length > 0) {
        activityWarnings.set(item.slug_value, warnings);
      }

      allActivities.push(item);
    }

    // Step 5: Upsert activities using batch processing
    logger(colorize("Upserting activity definitions...", 0));
    const results = await makeBatchApiCall(
      `/api/v1/facility/${finalConfig.facilityId}/activity_definition/upsert/`,
      allActivities.map(
        (item): ActivityDefinitionCreateSpec => ({
          title: item.title,
          slug_value: item.slug_value,
          description: item.description,
          usage: item.usage,
          status: item.status,
          classification: item.classification,
          kind: item.kind,
          facility: finalConfig.facilityId,
          category: `f-${finalConfig.facilityId}-${item.category}`,
          // Only include dependencies that exist
          specimen_requirements: item.specimens
            .filter((spec) => availableSlugs.specimens.includes(spec))
            .map((spec) => `f-${finalConfig.facilityId}-${spec}`),
          charge_item_definitions: item.chargeItems
            .filter((ci) => availableSlugs.chargeItems.includes(ci))
            .map((ci) => `f-${finalConfig.facilityId}-${ci}`),
          observation_result_requirements: item.observations
            .filter((obs) => availableSlugs.observations.includes(obs))
            .map((obs) => `f-${finalConfig.facilityId}-${obs}`),
          locations: item.locations || [],
          diagnostic_report_codes: item.diagnostic_report_loinc_codes,
          code: item.code!,
          body_site: item.body_site || null,
          derived_from_uri: item.derived_from_uri || null,
          healthcare_service: item.healthcare_service || null,
        }),
      ),
      finalConfig,
    );

    // Combine results from invalid activities and batch processing
    const allResults = [
      // Add results from API calls with warnings
      ...results.map((result) => {
        const warnings = activityWarnings.get(result.item.slug_value);
        let errorMessage = result.error;

        // Append warnings to error message if present
        if (warnings && warnings.length > 0) {
          const warningText = `Warnings: ${warnings.join("; ")}`;
          if (errorMessage) {
            if (typeof errorMessage === "string") {
              errorMessage = { message: errorMessage + "; " + warningText };
            } else if (errorMessage.message) {
              errorMessage = {
                message: errorMessage.message + "; " + warningText,
              };
            } else {
              errorMessage = { message: warningText };
            }
          } else {
            errorMessage = { message: warningText };
          }
        }

        return {
          success: result.success,
          error: errorMessage,
          item: result.item,
        };
      }),
      // Add invalid activities that were blocked from API call
      ...invalidActivities.map((invalid) => ({
        success: false,
        error: { message: invalid.error },
        item: invalid.item,
      })),
    ];

    // Update output data with status
    outputData = mapResultsToOutput(outputData, allResults);

    // Write output CSV with dynamic substitution columns
    logger(colorize("Writing output CSV...", 0));

    await writeOutputCsv(outputData, finalConfig.outputFile);

    // Process and return results
    return processApiResults(allResults, "activity");
  } catch (error) {
    logger(colorize(`Error in main process: ${error}`, 1));
    throw error;
  }
}

// Run the script
if (require.main === module) {
  const cliArgs = parseCliArgs();

  if (cliArgs.help) {
    showCliHelp("sudheendra-scripts/load-ActivityDefinition.ts");
    process.exit(0);
  }

  main();
}

export { main, processCsvData };
