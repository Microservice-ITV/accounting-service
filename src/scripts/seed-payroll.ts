import prisma from '../lib/prisma.js';

const MAIN_STORE_ID = '00468bc2-856e-4852-9e38-2609acb7e6cd';
const TAX_RATE = 0.1;
const STANDARD_WORKING_DAYS = 22;

type DemoEmployee = {
  id: string;
  code: string;
  name: string;
  userId: string;
  baseSalary: number;
  bonus: number;
};

const demoEmployees: DemoEmployee[] = [
  {
    id: 'e2000000-0000-4000-8000-000000000001',
    code: 'DNI-0001',
    name: 'Hla Hla',
    userId: 'e1000000-0000-4000-8000-000000000001',
    baseSalary: 9000,
    bonus: 0,
  },
  {
    id: 'e2000000-0000-4000-8000-000000000002',
    code: 'DNI-0002',
    name: 'Myo Myo',
    userId: 'e1000000-0000-4000-8000-000000000002',
    baseSalary: 4800,
    bonus: 0,
  },
  {
    id: 'e2000000-0000-4000-8000-000000000003',
    code: 'DNI-0003',
    name: 'Tun Tun',
    userId: 'e1000000-0000-4000-8000-000000000005',
    baseSalary: 8500,
    bonus: 0,
  },
  {
    id: 'e2000000-0000-4000-8000-000000000004',
    code: 'DNI-0004',
    name: 'Aung Aung',
    userId: 'e1000000-0000-4000-8000-000000000003',
    baseSalary: 1500,
    bonus: 120,
  },
  {
    id: 'e2000000-0000-4000-8000-000000000005',
    code: 'DNI-0005',
    name: 'Kyaw Kyaw',
    userId: 'e1000000-0000-4000-8000-000000000004',
    baseSalary: 1600,
    bonus: 120,
  },
];

const hrManager = demoEmployees[0];
const payrollOfficer = demoEmployees[1];

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const utcMonthStart = (value: Date) =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));

const utcMonthEnd = (value: Date) =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));

const utcMonthOffset = (value: Date, months: number) =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));

const addUtcDays = (value: Date, days: number) =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));

const referenceMonth = (value: Date) =>
  `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, '0')}`;

async function ensureDefaultPolicy() {
  const name = 'Default Payroll Policy';
  const data = {
    shopId: null,
    currency: 'USD',
    standardWorkingDays: STANDARD_WORKING_DAYS,
    standardDailyHours: 8,
    overtimeRateMultiplier: 1.5,
    taxRate: TAX_RATE,
    latenessDeductionPerMin: 0.25,
    absenceDeductionPerDay: 50,
    unpaidLeaveDeductionPerDay: 40,
    isActive: true,
    effectiveFrom: new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)),
    effectiveTo: null,
  };

  const existing = await prisma.payrollPolicy.findFirst({ where: { name } });

  return existing
    ? prisma.payrollPolicy.update({ where: { id: existing.id }, data })
    : prisma.payrollPolicy.create({ data: { ...data, name } });
}

async function refreshRunTotals(runId: string) {
  const aggregate = await prisma.payrollItem.aggregate({
    where: { payrollRunId: runId },
    _sum: { grossPay: true, totalDeductions: true, netPay: true },
    _count: { _all: true },
  });

  await prisma.payrollRun.update({
    where: { id: runId },
    data: {
      totalGross: aggregate._sum.grossPay ?? 0,
      totalDeductions: aggregate._sum.totalDeductions ?? 0,
      totalNet: aggregate._sum.netPay ?? 0,
      employeeCount: aggregate._count._all,
    },
  });
}

async function seedRun(
  policyId: string,
  suffix: string,
  monthOffset: number,
  status: 'PAID' | 'UNDER_REVIEW',
) {
  const today = new Date();
  const period = utcMonthOffset(today, monthOffset);
  const periodStart = utcMonthStart(period);
  const periodEnd = utcMonthEnd(period);
  const payDate = addUtcDays(periodEnd, 2);
  const isPaid = status === 'PAID';
  const calculatedAt = addUtcDays(periodStart, -1);
  const reviewedAt = new Date(calculatedAt.getTime() + 60 * 60 * 1000);
  const approvedAt = isPaid
    ? new Date(calculatedAt.getTime() + 2 * 60 * 60 * 1000)
    : null;

  const run = await prisma.payrollRun.upsert({
    where: { reference: `PR-${referenceMonth(periodStart)}-${suffix}` },
    update: {
      periodStart,
      periodEnd,
      payDate,
      status,
      shopId: null,
      payrollPolicyId: policyId,
      currency: 'USD',
      preparedBy: payrollOfficer.userId,
      approvedBy: isPaid ? hrManager.userId : null,
      calculatedAt,
      reviewedAt,
      approvedAt,
      paidAt: isPaid ? payDate : null,
      lockedAt: approvedAt,
      notes: `Seeded demo payroll run (${suffix}).`,
    },
    create: {
      reference: `PR-${referenceMonth(periodStart)}-${suffix}`,
      periodStart,
      periodEnd,
      payDate,
      status,
      shopId: null,
      payrollPolicyId: policyId,
      currency: 'USD',
      preparedBy: payrollOfficer.userId,
      approvedBy: isPaid ? hrManager.userId : null,
      calculatedAt,
      reviewedAt,
      approvedAt,
      paidAt: isPaid ? payDate : null,
      lockedAt: approvedAt,
      notes: `Seeded demo payroll run (${suffix}).`,
    },
  });

  for (const employee of demoEmployees) {
    const gross = roundMoney(employee.baseSalary + employee.bonus);
    const tax = roundMoney(gross * TAX_RATE);
    const net = roundMoney(gross - tax);
    const snapshot = {
      employee: {
        id: employee.id,
        employee_code: employee.code,
        full_name: employee.name,
      },
      period: {
        start: periodStart.toISOString(),
        end: periodEnd.toISOString(),
      },
    };

    const item = await prisma.payrollItem.upsert({
      where: {
        payrollRunId_employeeId: {
          payrollRunId: run.id,
          employeeId: employee.id,
        },
      },
      update: {
        baseSalary: employee.baseSalary,
        grossPay: gross,
        totalDeductions: tax,
        netPay: net,
        currency: 'USD',
        workedDays: STANDARD_WORKING_DAYS,
        absentDays: 0,
        unpaidLeaveDays: 0,
        overtimeMinutes: 0,
        snapshot: snapshot as never,
      },
      create: {
        payrollRunId: run.id,
        employeeId: employee.id,
        baseSalary: employee.baseSalary,
        grossPay: gross,
        totalDeductions: tax,
        netPay: net,
        currency: 'USD',
        workedDays: STANDARD_WORKING_DAYS,
        absentDays: 0,
        unpaidLeaveDays: 0,
        overtimeMinutes: 0,
        snapshot: snapshot as never,
      },
    });

    await prisma.payrollItemLine.deleteMany({
      where: { payrollItemId: item.id },
    });

    await prisma.payrollItemLine.createMany({
      data: [
        {
          payrollItemId: item.id,
          lineType: 'EARNING',
          category: 'BASE_SALARY',
          description: 'Base salary',
          quantity: STANDARD_WORKING_DAYS,
          rate: roundMoney(employee.baseSalary / STANDARD_WORKING_DAYS),
          amount: employee.baseSalary,
        },
        ...(employee.bonus > 0
          ? [
              {
                payrollItemId: item.id,
                lineType: 'EARNING' as const,
                category: 'BONUS' as const,
                description: 'Performance bonus',
                quantity: 0,
                rate: 0,
                amount: employee.bonus,
              },
            ]
          : []),
        {
          payrollItemId: item.id,
          lineType: 'DEDUCTION',
          category: 'TAX',
          description: 'Income tax',
          quantity: 0,
          rate: TAX_RATE,
          amount: tax,
        },
      ],
    });

    if (!isPaid) {
      continue;
    }

    await prisma.payslip.upsert({
      where: { payrollItemId: item.id },
      update: {
        payslipNumber: `PS-${referenceMonth(periodEnd)}-${employee.code}`,
        payrollRunId: run.id,
        employeeId: employee.id,
        status: 'ISSUED',
        generatedAt: payDate,
        issuedAt: payDate,
        revokedAt: null,
        fileUrl: null,
        snapshot: snapshot as never,
      },
      create: {
        payslipNumber: `PS-${referenceMonth(periodEnd)}-${employee.code}`,
        payrollRunId: run.id,
        payrollItemId: item.id,
        employeeId: employee.id,
        status: 'ISSUED',
        generatedAt: payDate,
        issuedAt: payDate,
        revokedAt: null,
        fileUrl: null,
        snapshot: snapshot as never,
      },
    });

    const paymentData = {
      payrollItemId: item.id,
      method: 'BANK_TRANSFER' as const,
      status: 'RECONCILED' as const,
      amount: net,
      currency: 'USD',
      reference: `PAY-${run.reference}-${employee.code}`,
      bankName: 'KBZ Bank',
      accountLast4: employee.userId.slice(-4),
      paidAt: payDate,
      processedBy: employee.userId,
    };

    const existingPayment = await prisma.paymentRecord.findFirst({
      where: { payrollRunId: run.id, employeeId: employee.id },
    });

    if (existingPayment) {
      await prisma.paymentRecord.update({
        where: { id: existingPayment.id },
        data: paymentData,
      });
    } else {
      await prisma.paymentRecord.create({
        data: {
          ...paymentData,
          payrollRunId: run.id,
          employeeId: employee.id,
        },
      });
    }
  }

  await refreshRunTotals(run.id);

  const auditActions: Array<{
    action: string;
    actor: DemoEmployee;
    description: string;
  }> = [
    {
      action: 'CREATED',
      actor: payrollOfficer,
      description: 'Payroll run created',
    },
    {
      action: 'CALCULATED',
      actor: payrollOfficer,
      description: 'Payroll run calculated',
    },
    {
      action: 'SUBMITTED',
      actor: payrollOfficer,
      description: 'Submitted for review',
    },
    ...(isPaid
      ? [
          {
            action: 'APPROVED',
            actor: hrManager,
            description: 'Payroll run approved',
          },
          {
            action: 'PAID',
            actor: payrollOfficer,
            description: 'Payroll run marked as paid',
          },
        ]
      : []),
  ];

  for (const [index, { action, actor, description }] of auditActions.entries()) {
    const existingLog = await prisma.payrollAuditLog.findFirst({
      where: {
        payrollRunId: run.id,
        action,
        description,
      },
    });
    const data = {
      actorId: actor.userId,
      actorName: actor.name,
      createdAt: new Date(calculatedAt.getTime() + index * 60 * 1000),
    };

    if (existingLog) {
      await prisma.payrollAuditLog.update({
        where: { id: existingLog.id },
        data,
      });
    } else {
      await prisma.payrollAuditLog.create({
        data: {
          ...data,
          payrollRunId: run.id,
          action,
          description,
        },
      });
    }
  }
}

async function seedDraftRun(policyId: string, suffix: string) {
  const period = utcMonthOffset(new Date(), 0);
  const periodStart = utcMonthStart(period);
  const periodEnd = utcMonthEnd(period);

  await prisma.payrollRun.upsert({
    where: { reference: `PR-${referenceMonth(periodStart)}-${suffix}` },
    update: {
      periodStart,
      periodEnd,
      payDate: null,
      status: 'DRAFT',
      shopId: MAIN_STORE_ID,
      payrollPolicyId: policyId,
      currency: 'USD',
      preparedBy: null,
      approvedBy: null,
      calculatedAt: null,
      reviewedAt: null,
      approvedAt: null,
      paidAt: null,
      lockedAt: null,
      notes: 'Draft run scoped to the main store.',
    },
    create: {
      reference: `PR-${referenceMonth(periodStart)}-${suffix}`,
      periodStart,
      periodEnd,
      payDate: null,
      status: 'DRAFT',
      shopId: MAIN_STORE_ID,
      payrollPolicyId: policyId,
      currency: 'USD',
      notes: 'Draft run scoped to the main store.',
    },
  });
}

export async function seedPayrollDemoData() {
  const policy = await ensureDefaultPolicy();

  await seedRun(policy.id, 'DEMO1', -1, 'PAID');
  await seedRun(policy.id, 'DEMO2', 0, 'UNDER_REVIEW');
  await seedDraftRun(policy.id, 'DEMO3');

  console.log(
    'Accounting payroll seed complete: default policy, one paid run, one under-review run, and one draft run were ensured.',
  );
}
