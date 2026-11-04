import prisma from '../lib/prisma.js';
import {
  seedRequiredMasterData,
  shouldSeedRequiredMasterData,
} from './seed-accounts.js';
import { seedPayrollDemoData } from './seed-payroll.js';

const runSeed = async () => {
  if (!shouldSeedRequiredMasterData()) {
    console.log(
      'Accounting seed is disabled; skipping required master-data and payroll setup.',
    );
    return;
  }

  await seedRequiredMasterData();
  await seedPayrollDemoData();
};

runSeed()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error('Accounting seed failed:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
