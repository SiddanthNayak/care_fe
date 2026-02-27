import {
  ResourceCategoryRead,
  ResourceCategoryResourceType,
  ResourceCategorySubType,
} from "@/types/base/resourceCategory/resourceCategory";
import {
  ProductKnowledgeBase,
  ProductKnowledgeCreate,
  ProductKnowledgeStatus,
  ProductKnowledgeType,
  ProductNameTypes,
} from "@/types/inventory/productKnowledge/productKnowledge";
import { PaginatedResponse } from "@/Utils/request/types";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { createSlug, getLogger, request } from "sudheendra-scripts/utils";

const logger = getLogger();

const FAILED_OUTPUT_FILE = "failed-product-knowledges.json";

const getConfig = () => {
  const facilityIds = process.env.FACILITY_IDS?.split(",") || [];
  if (facilityIds.length === 0) {
    throw new Error("FACILITY_IDS is not set");
  }

  const localCsvPath = process.env.PRODUCT_KNOWLEDGE_CSV_PATH?.trim() || "";

  const googleSheetId = process.env.PRODUCT_KNOWLEDGE_GOOGLE_SHEET_ID || "";
  const sheetName = process.env.PRODUCT_KNOWLEDGE_SHEET_NAME || "";

  if (!localCsvPath && (!googleSheetId || !sheetName)) {
    throw new Error(
      "Set PRODUCT_KNOWLEDGE_CSV_PATH for local CSV, or PRODUCT_KNOWLEDGE_GOOGLE_SHEET_ID and PRODUCT_KNOWLEDGE_SHEET_NAME for Google Sheets",
    );
  }

  return { facilityIds, googleSheetId, sheetName, localCsvPath };
};

const headerMap = {
  resourceCategory: 0,

  //product knowledge
  slug: 1,
  name: 2,
  productType: 3,
  codeDisplay: 4,
  codeValue: 5,
  baseUnitDisplay: 6,
  // status: 4,
  dosageFormDisplay: 7,
  dosageFormCode: 8,
  routeCode: 9,
  routeDisplay: 10,
  alternateIdentifier: 11,
  alternateNameType: 12,
  alternateNameValue: 13,
};

const requiredHeaderKeys = [
  "resourceCategory",
  "name",
  "productType",
  "baseUnitDisplay",
] satisfies (keyof typeof headerMap)[];

const SNOMED_SYSTEM = "http://snomed.info/sct";

const DOSAGE_UNITS_CODES = [
  { system: "http://unitsofmeasure.org", code: "{tbl}", display: "tablets" },
  {
    system: "http://unitsofmeasure.org",
    code: "{Capsule}",
    display: "capsules",
  },
  { system: "http://unitsofmeasure.org", code: "mL", display: "milliliter" },
  { system: "http://unitsofmeasure.org", code: "mg", display: "milligram" },
  { system: "http://unitsofmeasure.org", code: "g", display: "gram" },
  { system: "http://unitsofmeasure.org", code: "ug", display: "microgram" },
  { system: "http://unitsofmeasure.org", code: "L", display: "liter" },
  {
    system: "http://unitsofmeasure.org",
    code: "[iU]",
    display: "international unit",
  },
  { system: "http://unitsofmeasure.org", code: "{count}", display: "count" },
  { system: "http://unitsofmeasure.org", code: "[drp]", display: "drop" },
  {
    system: "http://unitsofmeasure.org",
    code: "mg/mL",
    display: "milligram per milliliter",
  },
] as const;

const parseCsvList = (value?: string) =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

interface CsvParseResult {
  headers: string[];
  rows: string[][];
}

function parseCsvText(csvText: string): CsvParseResult {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map(splitCsvLine);
  logger(
    `Parsed CSV with ${headers.length} columns and ${rows.length} rows ${JSON.stringify(rows)}`,
  );
  return { headers, rows };
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim().replace(/^"(.*)"$/, "$1"));
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim().replace(/^"(.*)"$/, "$1"));
  return result;
}

async function fetchCsvTextFromGoogleSheet(
  googleSheetId: string,
  sheetName: string,
): Promise<string> {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${googleSheetId}/gviz/tq?tqx=out:csv&sheet=${sheetName}`;
  const response = await fetch(csvUrl, { headers: { Accept: "text/csv" } });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch CSV from Google Sheet: ${response.statusText}`,
    );
  }

  return await response.text();
}

export function createProductKnowledgeSlug(name: string) {
  // this will hash the name and return a slug unlike `createSlug`
  return `${createSlug(name).slice(0, 20)}-${createHash("sha256").update(name).digest("hex").slice(0, 5)}`;
}

async function main() {
  const { facilityIds, googleSheetId, sheetName, localCsvPath } = getConfig();
  const csvText = localCsvPath
    ? fs.readFileSync(path.resolve(localCsvPath), "utf-8")
    : await fetchCsvTextFromGoogleSheet(googleSheetId, sheetName);
  const { rows } = parseCsvText(csvText);
  const datapoints = rows
    .map((row) => {
      const datapoint = (
        Object.keys(headerMap) as Array<keyof typeof headerMap>
      ).reduce(
        (acc, key) => {
          const idx = headerMap[key];
          if (typeof idx === "number") {
            acc[key] = row[idx] ?? "";
          } else {
            acc[key] = "";
          }
          return acc;
        },
        {} as Record<keyof typeof headerMap, string>,
      );

      return datapoint;
    })
    .map(getValidatedDatapoint);

  const failedProducts: { name: string }[] = [];

  const resourceCategories = [
    ...new Set(datapoints.map((dp) => dp.resourceCategory)),
  ];

  for (const facilityId of facilityIds) {
    logger(
      `Upserting resource categories and product knowledges for facility ${facilityId}`,
    );
    await upsertResourceCategories(facilityId, resourceCategories);
    await upsertProductKnowledges(facilityId, datapoints, failedProducts);
  }

  if (failedProducts.length > 0) {
    const outputPath = path.resolve(process.cwd(), FAILED_OUTPUT_FILE);
    fs.writeFileSync(outputPath, JSON.stringify(failedProducts, null, 2));
    logger(`Saved ${failedProducts.length} failures to ${FAILED_OUTPUT_FILE}`);
  }
}

main();

function getValidatedDatapoint(
  datapoint: Record<keyof typeof headerMap, string>,
) {
  if (requiredHeaderKeys.some((key) => !datapoint[key].trim())) {
    throw new Error(
      `Missing required header in datapoint ${JSON.stringify(datapoint)}`,
    );
  }

  const baseUnit = DOSAGE_UNITS_CODES.find(
    (unit) => unit.display === datapoint.baseUnitDisplay.toLowerCase(),
  );
  if (!baseUnit) {
    throw new Error(
      `Could not resolve base unit for '${datapoint.baseUnitDisplay}'`,
    );
  }

  const slug = datapoint.slug || createProductKnowledgeSlug(datapoint.name);

  const productType = [
    ProductKnowledgeType.consumable,
    ProductKnowledgeType.medication,
    ProductKnowledgeType.nutritional_product,
  ].find((type) => type === datapoint.productType.toLowerCase());

  if (!productType) {
    throw new Error(`Product type '${datapoint.productType}' is not valid`);
  }

  let alternateNameType: ProductNameTypes | undefined;

  if (datapoint?.alternateNameType) {
    alternateNameType = [
      ProductNameTypes.trade_name,
      ProductNameTypes.alias,
      ProductNameTypes.original_name,
      ProductNameTypes.preferred,
    ].find(
      (type) =>
        type ===
        datapoint?.alternateNameType.toLowerCase().replaceAll(" ", "_"),
    );

    if (!alternateNameType) {
      throw new Error(
        `Alternate name type '${datapoint.alternateNameType}' is not valid`,
      );
    }
  }

  const dosageFormCode = datapoint.dosageFormCode?.trim();
  const dosageFormDisplay = datapoint.dosageFormDisplay?.trim();

  const routeCodes = parseCsvList(datapoint.routeCode);
  const routeDisplays = parseCsvList(datapoint.routeDisplay);

  const intendedRoutes = routeCodes.map((code, index) => ({
    system: SNOMED_SYSTEM,
    code,
    display: routeDisplays[index] || routeDisplays[0] || code,
  }));

  const dosageForm = dosageFormCode
    ? {
        system: SNOMED_SYSTEM,
        code: dosageFormCode,
        display: dosageFormDisplay || dosageFormCode,
      }
    : undefined;

  const codeValue = datapoint.codeValue?.trim();
  const codeDisplay = datapoint.codeDisplay?.trim();
  const code = codeValue
    ? {
        system: SNOMED_SYSTEM,
        code: codeValue,
        display: codeDisplay || codeValue,
      }
    : undefined;

  return {
    ...datapoint,
    baseUnit,
    slug,
    productType,
    alternateNameType,
    dosageForm,
    intendedRoutes,
    code,
  };
}

async function upsertResourceCategories(
  facilityId: string,
  resourceCategories: string[],
) {
  const existingCategories = (await request(
    `/api/v1/facility/${facilityId}/resource_category/?limit=100&resource_type=${ResourceCategoryResourceType.product_knowledge}&resource_sub_type=${ResourceCategorySubType.other}`,
    "GET",
  )) as PaginatedResponse<ResourceCategoryRead>;

  const existingSlugs = new Set(
    existingCategories.results.map((cat) => cat.slug_config.slug_value),
  );
  const newDatapoints = resourceCategories.filter(
    (cat) => !existingSlugs.has(`pk-${createSlug(cat)}`),
  );

  logger(
    `${newDatapoints.length} new categories to create (${resourceCategories.length - newDatapoints.length} already exist)`,
  );

  if (newDatapoints.length === 0) {
    logger("No new categories to create");
    return existingCategories.results;
  }

  // Only upsert new categories
  await request(
    `/api/v1/facility/${facilityId}/resource_category/upsert/`,
    "POST",
    {
      datapoints: newDatapoints.map((data) => ({
        title: data,
        slug_value: `pk-${createSlug(data)}`,
        resource_type: ResourceCategoryResourceType.product_knowledge,
        resource_sub_type: ResourceCategorySubType.other,
      })),
    },
  );
}

async function getExistingProductKnowledgeSlugs(facilityId: string) {
  const results: ProductKnowledgeBase[] = [];

  let hasNextPage = true;
  let page = 0;

  while (hasNextPage) {
    const existingProductKnowledges: PaginatedResponse<ProductKnowledgeBase> =
      await request(
        `/api/v1/product_knowledge/?facility=${facilityId}&limit=100&offset=${page * 100}`,
        "GET",
      );

    results.push(...existingProductKnowledges.results);

    if (existingProductKnowledges.results.length < 100) {
      hasNextPage = false;
    }

    page++;
  }

  return new Set(results.map((pk) => pk.slug_config.slug_value));
}

async function upsertProductKnowledges(
  facilityId: string,
  datapoints: ReturnType<typeof getValidatedDatapoint>[],
  failedProducts: { name: string }[],
) {
  logger(
    `Processing ${datapoints.length} product knowledges for facility ${facilityId}`,
  );

  const existingProductKnowledgeSlugs =
    await getExistingProductKnowledgeSlugs(facilityId);

  const newDatapoints = datapoints.filter(
    (dp) => !existingProductKnowledgeSlugs.has(dp.slug),
  );

  if (newDatapoints.length === 0) {
    logger("No new product knowledges to create");
    return;
  }

  logger(
    `${newDatapoints.length} new product knowledges to create (${datapoints.length - newDatapoints.length} already exist)`,
  );

  for (const datapoint of newDatapoints) {
    const productKnowledge: ProductKnowledgeCreate = {
      slug_value: datapoint.slug,
      name: datapoint.name,
      facility: facilityId,
      product_type: datapoint.productType,
      status: ProductKnowledgeStatus.active,
      base_unit: datapoint.baseUnit,
      category: `f-${facilityId}-pk-${createSlug(datapoint.resourceCategory)}`,
      names: [],
      storage_guidelines: [],
      is_instance_level: false,
    };

    if (datapoint.code) {
      productKnowledge.code = datapoint.code;
    }

    if (datapoint.dosageForm) {
      productKnowledge.definitional = {
        dosage_form: datapoint.dosageForm,
        intended_routes: datapoint.intendedRoutes,
        ingredients: [],
        nutrients: [],
        drug_characteristic: [],
      };
    }

    // Add alternate identifier if provided
    if (datapoint.alternateIdentifier) {
      productKnowledge.alternate_identifier = datapoint.alternateIdentifier;
    }

    // Add alternate name if provided
    if (datapoint.alternateNameType && datapoint.alternateNameValue) {
      productKnowledge.names = [
        {
          name_type: datapoint.alternateNameType,
          name: datapoint.alternateNameValue,
        },
      ];
    }

    try {
      await request("/api/v1/product_knowledge/", "POST", productKnowledge);
      logger(`Created product knowledge: ${datapoint.slug}`);
    } catch (error) {
      logger(`Error creating product knowledge: ${JSON.stringify(datapoint)}`);
      logger(`Error details: ${String(error)}`);
      failedProducts.push({ name: datapoint.name });
    }
  }
}
