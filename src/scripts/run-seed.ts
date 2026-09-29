import prisma from '../lib/prisma.js';
import { seedRequiredMasterData } from './seed-accounts.js';

seedRequiredMasterData()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error('Accounting seed failed:', error);
    await prisma.$disconnect();
    process.exit(1);
  });