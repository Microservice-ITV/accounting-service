export type EmployeeDirectoryRecord = {
  id: string;
  employeeCode: string | null;
  fullName: string | null;
};

export interface IEmployeeDirectory {
  findById(employeeId: string): Promise<EmployeeDirectoryRecord | null>;
}
