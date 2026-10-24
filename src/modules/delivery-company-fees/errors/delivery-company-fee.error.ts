export class DeliveryCompanyFeeApplicationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'DeliveryCompanyFeeApplicationError';
  }
}
