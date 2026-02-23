import type { MonetaryComponentType } from "@/types/base/monetaryComponent/monetaryComponent";
import {
  ResourceCategoryRead,
  ResourceCategoryResourceType,
  ResourceCategorySubType,
} from "@/types/base/resourceCategory/resourceCategory";
import {
  ChargeItemDefinitionBase,
  ChargeItemDefinitionCreate,
  ChargeItemDefinitionStatus,
} from "@/types/billing/chargeItemDefinition/chargeItemDefinition";
import { createHash } from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  getExistingChargeItemDefinitionsByResourceCategorySlug,
  getExistingChargeItemDefinitionSlugs,
} from "sudheendra-scripts/inventory-from-db/utils";
import {
  createSlug,
  fetchCsvFromGoogleSheet,
  request,
  transformCsvToObjects,
} from "sudheendra-scripts/utils";

dotenv.config({ path: [".env.local", ".env"] });

const getConfig = () => {
  const facilityId = process.env.FACILITY_ID!;
  if (facilityId.length === 0) {
    throw new Error("FACILITY_ID is not set");
  }

  const googleSheetId = process.env.CHARGE_ITEM_DEFINITION_GOOGLE_SHEET_ID!;
  if (!googleSheetId) {
    throw new Error("CHARGE_ITEM_DEFINITION_GOOGLE_SHEET_ID is not set");
  }

  const sheetName = process.env.CHARGE_ITEM_DEFINITION_SHEET_NAME!;
  if (!sheetName) {
    throw new Error("CHARGE_ITEM_DEFINITION_SHEET_NAME is not set");
  }

  const sheetTitle = process.env.CHARGE_ITEM_DEFINITION_SHEET_TITLE!;
  if (!sheetTitle) {
    throw new Error("CHARGE_ITEM_DEFINITION_SHEET_TITLE is not set");
  }

  return { facilityId, googleSheetId, sheetName, sheetTitle };
};

const OUTPUT_FILE = "charge-item-definition-slugs.json";

const headerMap = {
  title: 0,
  description: 1,
  purpose: 2,
  price: 3,
};

function createChargeItemDefinitionSlug(name: string) {
  // this will hash the name and return a slug unlike `createSlug`
  return `${createSlug(name).slice(0, 20)}-${createHash("sha256").update(name).digest("hex").slice(0, 5)}`;
}

const createResourceCategory = async (
  facilityId: string,
  title: string,
): Promise<ResourceCategoryRead> => {
  try {
    const response = await request(
      `/api/v1/facility/${facilityId}/resource_category/`,
      "POST",
      {
        title,
        slug_value: createSlug(title),
        resource_type: ResourceCategoryResourceType.charge_item_definition,
        resource_sub_type: ResourceCategorySubType.other,
      },
    );
    return response as ResourceCategoryRead;
  } catch (error) {
    console.error(`Failed to create resource category "${title}":`, error);
    throw error;
  }
};

const creatChargeItemDefinition = async (
  facilityId: string,
  resourceCategorySlug: string,
  datapoints: Record<keyof typeof headerMap, string>[],
) => {
  const existingSlugs = await getExistingChargeItemDefinitionSlugs();
  const createdItems: { id: string; slug: string }[] = [];

  console.log(`Found ${existingSlugs.length} existing charge item definitions`);

  for (const datapoint of datapoints) {
    const { title, price, description, purpose } = datapoint;
    const slug = createChargeItemDefinitionSlug(title);

    if (existingSlugs.includes(slug)) {
      const response = await request<ChargeItemDefinitionBase>(
        `/api/v1/facility/${facilityId}/charge_item_definition/${slug}/`,
        "PUT",
        {
          title,
          slug_value: slug,
          status: ChargeItemDefinitionStatus.active,
          category: resourceCategorySlug,
          description,
          purpose,
          can_edit_charge_item: true,
          price_components: [
            {
              monetary_component_type: "base" as MonetaryComponentType,
              amount: price,
            },
          ],
        } as ChargeItemDefinitionCreate,
      );
      createdItems.push({ id: response.id, slug: response.slug });
      console.log(`Updated charge item definition: ${title}`);
      continue;
    }

    const chargeItemDefinition: ChargeItemDefinitionCreate = {
      title,
      slug_value: slug,
      status: ChargeItemDefinitionStatus.active,
      category: resourceCategorySlug,
      description,
      purpose,
      can_edit_charge_item: true,
      price_components: [
        {
          monetary_component_type: "base" as MonetaryComponentType,
          amount: price,
        },
      ],
    };

    const response = await request<ChargeItemDefinitionBase>(
      `/api/v1/facility/${facilityId}/charge_item_definition/`,
      "POST",
      chargeItemDefinition,
    );
    createdItems.push({ id: response.id, slug: response.slug });

    console.log(`Created charge item definition: ${title}`);
  }

  if (createdItems.length > 0) {
    const outputPath = path.resolve(process.cwd(), OUTPUT_FILE);
    fs.writeFileSync(outputPath, JSON.stringify(createdItems, null, 2));
    console.log(
      `Saved ${createdItems.length} charge item slugs to ${OUTPUT_FILE}`,
    );
  }
};

const retireChargeItemDefinition = async (
  facilityId: string,
  resourceCategorySlug: string,
) => {
  const existingChargeItemDefinitions =
    await getExistingChargeItemDefinitionsByResourceCategorySlug(
      resourceCategorySlug,
    );
  for (const chargeItemDefinition of existingChargeItemDefinitions) {
    await request(
      `/api/v1/facility/${facilityId}/charge_item_definition/${chargeItemDefinition.slug}/`,
      "PUT",
      {
        title: chargeItemDefinition.title,
        slug_value: chargeItemDefinition.slug_config.slug_value,
        status: ChargeItemDefinitionStatus.retired,
        category: resourceCategorySlug,
        price_components: chargeItemDefinition.price_components,
      } as ChargeItemDefinitionCreate,
    );
    console.log(
      `Retired charge item definition: ${chargeItemDefinition.title}`,
    );
  }
};

async function main() {
  const { facilityId, googleSheetId, sheetName, sheetTitle } = getConfig();
  const csvData = await fetchCsvFromGoogleSheet(googleSheetId, sheetName);
  const datapoints = transformCsvToObjects(csvData, headerMap);
  await createResourceCategory(facilityId, sheetTitle);
  const resourceCategorySlug = `f-${facilityId}-${createSlug(sheetTitle)}`;
  await retireChargeItemDefinition(facilityId, resourceCategorySlug);

  await creatChargeItemDefinition(facilityId, resourceCategorySlug, datapoints);
}

main();
