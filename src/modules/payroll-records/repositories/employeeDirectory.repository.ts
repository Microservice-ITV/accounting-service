import type {
  EmployeeDirectoryRecord,
  IEmployeeDirectory,
} from '../interfaces/employeeDirectory.interface.js';

type EmployeeLookupResponse = {
  success?: boolean;
  data?: {
    employee?: {
      id?: string;
      employee_code?: string | null;
      full_name?: string | null;
    };
  };
};

const employeeServiceBaseUrl = () =>
  (process.env.EMPLOYEE_SERVICE_BASE_URL ?? 'http://localhost:8081/api/v1').replace(/\/$/, '');

const employeeServiceInternalKey = () =>
  process.env.EMPLOYEE_SERVICE_INTERNAL_KEY || process.env.INTERNAL_SERVICE_KEY || '';

export class EmployeeDirectoryRepository implements IEmployeeDirectory {
  async findById(employeeId: string): Promise<EmployeeDirectoryRecord | null> {
    const internalKey = employeeServiceInternalKey();
    if (!internalKey) {
      throw new Error('Employee Service credentials are not configured');
    }

    let response: Response;
    try {
      response = await fetch(
        `${employeeServiceBaseUrl()}/internal/employees/${encodeURIComponent(employeeId)}/lookup`,
        {
          headers: {
            Accept: 'application/json',
            'X-Internal-Service-Key': internalKey,
          },
        },
      );
    } catch {
      throw new Error('Unable to verify employee');
    }

    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Unable to verify employee');

    const payload = (await response.json().catch(() => null)) as EmployeeLookupResponse | null;
    const employee = payload?.data?.employee;

    if (!employee?.id || employee.id !== employeeId) return null;

    return {
      id: employee.id,
      employeeCode: employee.employee_code ?? null,
      fullName: employee.full_name ?? null,
    };
  }
}
