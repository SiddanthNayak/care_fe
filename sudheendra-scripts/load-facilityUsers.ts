import { getExistingUsers } from "sudheendra-scripts/inventory-from-db/utils";
import {
  fetchCsvFromGoogleSheet,
  getLogger,
  request,
  transformCsvToObjects,
} from "./utils";

const getConfig = () => {
  const departmentUsersSheetId = process.env.DEPARTMENT_USERS_SHEET_ID!;
  if (!departmentUsersSheetId) {
    throw new Error("DEPARTMENT_USERS_SHEET_ID is not set");
  }
  const departmentUsersSheetName = process.env.DEPARTMENT_USERS_SHEET_NAME!;
  if (!departmentUsersSheetName) {
    throw new Error("DEPARTMENT_USERS_SHEET_NAME is not set");
  }

  const facilityId = process.env.FACILITY_ID!;
  if (!facilityId) {
    throw new Error("FACILITY_ID is not set");
  }
  return { departmentUsersSheetId, departmentUsersSheetName, facilityId };
};

const headerMap = {
  username: 15,
  organizationId: 14,
  roleId: 12,
};

const logger = getLogger();

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const isUuid = (value: string) => UUID_PATTERN.test(value);

async function linkFacilityUsers(
  datapoints: Record<keyof typeof headerMap, string>[],
  facilityId: string,
) {
  const existingUsers = await getExistingUsers();
  for (const datapoint of datapoints) {
    const { username, organizationId, roleId } = datapoint;
    const userId = isUuid(username)
      ? username
      : existingUsers.get(username)?.id;

    if (!userId) {
      logger(`Skipping: user not found for username '${username}'.`);
      continue;
    }

    try {
      await request(
        `/api/v1/facility/${facilityId}/organizations/${organizationId}/users/`,
        "POST",
        {
          user: userId,
          role: roleId,
        },
      );
      logger(
        `Link user ${username} to organization ${organizationId} with role ${roleId}`,
      );
    } catch (error: any) {
      if (error.message.includes("User association already exists")) {
        await request(
          `/api/v1/facility/${facilityId}/organizations/${organizationId}/users/${userId}/`,
          "PUT",
          {
            role: roleId,
          },
        );
        logger(
          `Update role of user ${username} in organization ${organizationId} to ${roleId}`,
        );
      } else {
        throw error;
      }
    }
  }
}

async function main() {
  const { departmentUsersSheetId, departmentUsersSheetName, facilityId } =
    getConfig();
  const csvData = await fetchCsvFromGoogleSheet(
    departmentUsersSheetId,
    departmentUsersSheetName,
  );
  const datapoints = transformCsvToObjects(csvData, headerMap);
  await linkFacilityUsers(datapoints, facilityId);
}

main();
