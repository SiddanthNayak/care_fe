import {
  fetchCsvFromGoogleSheet,
  getLogger,
  request,
  transformCsvToObjects,
} from "./utils";

const getConfig = () => {
  const googleSheetId = process.env.DEPARTMENT_USERS_SHEET_ID!;
  if (!googleSheetId) {
    throw new Error("DEPARTMENT_USERS_SHEET_ID is not set");
  }

  const sheetName = process.env.DEPARTMENT_SHEET_NAME!;
  if (!sheetName) {
    throw new Error("DEPARTMENT_SHEET_NAME is not set");
  }

  const facilityId = process.env.FACILITY_ID!;
  if (!facilityId) {
    throw new Error("FACILITY_ID is not set");
  }

  return { googleSheetId, sheetName, facilityId };
};

const headerMap = {
  departmentName: 0,
};

const requiredHeaderKeys = ["departmentName"] as const;

const logger = getLogger();

async function main() {
  const { googleSheetId, sheetName, facilityId } = getConfig();
  const csvData = await fetchCsvFromGoogleSheet(googleSheetId, sheetName);
  const datapoints = transformCsvToObjects(csvData, headerMap).map(
    getValidatedDatapoint,
  );

  await createDepartments(datapoints, facilityId);
}

const getValidatedDatapoint = (
  datapoint: Record<keyof typeof headerMap, string>,
) => {
  if (requiredHeaderKeys.some((key) => !datapoint[key].trim())) {
    throw new Error(
      `Missing required header in datapoint ${JSON.stringify(datapoint)}`,
    );
  }

  return {
    name: datapoint.departmentName.trim(),
  };
};

async function createDepartments(
  datapoints: ReturnType<typeof getValidatedDatapoint>[],
  facilityId: string,
) {
  const failed: { name: string; error: string }[] = [];

  for (const datapoint of datapoints) {
    try {
      const result = await request(
        `/api/v1/facility/${facilityId}/organizations/`,
        "POST",
        {
          name: datapoint.name,
          description: "",
          org_type: "dept",
          facility: facilityId,
        },
      );
      if (!result) {
        failed.push({ name: datapoint.name, error: "No response" });
        continue;
      }
      logger(`Created department: ${datapoint.name}`);
    } catch (error: any) {
      logger(
        `⚠ Failed to create department ${datapoint.name}: ${error.message}`,
      );
      failed.push({ name: datapoint.name, error: error.message });
    }
  }

  if (failed.length > 0) {
    logger(`\n\n===== FAILED DEPARTMENTS (${failed.length}) =====`);
    for (const f of failed) {
      logger(`  ✗ ${f.name}: ${f.error}`);
    }
  }
}

main();
