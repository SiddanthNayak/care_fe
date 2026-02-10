import { GENDERS } from "@/common/constants";
import { UserRead } from "@/types/user/user";
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

  const sheetName = process.env.DEPARTMENT_USERS_SHEET_NAME!;
  if (!sheetName) {
    throw new Error("DEPARTMENT_USERS_SHEET_NAME is not set");
  }
  const facilityId = process.env.FACILITY_ID!;
  if (!facilityId) {
    throw new Error("FACILITY_ID is not set");
  }

  return { googleSheetId, sheetName, facilityId };
};

const headerMap = {
  userType: 1,
  prefix: 2,
  firstName: 3,
  lastName: 4,
  email: 6,
  phoneNumber: 7,
  gender: 8,
  geoOrganization: 10,
  username: 15,
  password: 16,
};

const requiredHeaderKeys = [
  "userType",
  "prefix",
  "firstName",
  "lastName",
  "email",
  "phoneNumber",
  "gender",
  "password",
  "username",
] as const;

const logger = getLogger();

async function main() {
  const { googleSheetId, sheetName, facilityId } = getConfig();
  const csvData = await fetchCsvFromGoogleSheet(googleSheetId, sheetName);
  const datapoints = transformCsvToObjects(csvData, headerMap).map(
    getValidatedDatapoint,
  );

  await createDepartmentUsers(datapoints, facilityId);
}

const getValidatedDatapoint = (
  datapoint: Record<keyof typeof headerMap, string>,
) => {
  if (requiredHeaderKeys.some((key) => !datapoint[key].trim())) {
    throw new Error(
      `Missing required header in datapoint ${JSON.stringify(datapoint)}`,
    );
  }

  const gender = GENDERS.find(
    (gender) => gender === datapoint.gender.toLowerCase(),
  );
  if (!gender) {
    throw new Error(`Invalid gender: ${datapoint.gender.toLowerCase()}`);
  }

  const userName = datapoint.username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");

  return {
    ...datapoint,
    gender,
    userType: datapoint.userType.toLowerCase(),
    userName,
  };
};

async function createDepartmentUsers(
  datapoints: ReturnType<typeof getValidatedDatapoint>[],
  facilityId: string,
) {
  const failed: { userName: string; error: string }[] = [];

  for (const datapoint of datapoints) {
    let existingUser: UserRead | null = null;
    try {
      existingUser = await request<UserRead>(
        `/api/v1/users/${datapoint.userName}/`,
        "GET",
      );
    } catch {
      // 404 means user doesn't exist yet — expected
      existingUser = null;
    }
    if (existingUser) {
      logger(`User ${datapoint.userName} already exists`);
      continue;
    }
    try {
      const newUser = await request<UserRead>("/api/v1/users/", "POST", {
        user_type: datapoint.userType,
        username: datapoint.userName,
        email: datapoint.email,
        first_name: datapoint.firstName,
        last_name: datapoint.lastName,
        gender: datapoint.gender,
        password: datapoint.password,
        phone_number: datapoint.phoneNumber,
        geo_organization: datapoint.geoOrganization,
      });
      if (!newUser) {
        failed.push({ userName: datapoint.userName, error: "No response" });
        continue;
      }
      logger(`Created user ${datapoint.userName}`);
    } catch (error: any) {
      logger(`⚠ Failed to create user ${datapoint.userName}: ${error.message}`);
      failed.push({ userName: datapoint.userName, error: error.message });
    }
  }

  if (failed.length > 0) {
    logger(`\n\n===== FAILED USERS (${failed.length}) =====`);
    for (const f of failed) {
      logger(`  ✗ ${f.userName}: ${f.error}`);
    }
  }
}

main();
