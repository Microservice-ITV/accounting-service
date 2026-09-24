import { z } from 'zod';

export type ExpenseAuthContext = {
	userId: string;
	activeShopId?: string | null;
	authorizedShopIds?: Iterable<string>;
	shops?: Array<{ shop_id?: string | null; role?: { code?: string | null; name?: string | null } | null }>;
};

export type CreateExpenseInput = {
	amount: number;
	expenseDate?: Date | string;
	expenseAccountCode?: string;
	fundingAccountCode?: string;
	eventId?: string;
	expenseCategoryId?: string;
	category?: string;
	description?: string;
	receiptImage?: string;
	shopId?: string | null;
};

export type ExpenseCategoryInput = {
	code: string;
	name: string;
	description?: string | null;
	status?: string;
};

export const expenseSchema = z.object({
	shopId: z.string().trim().min(1),
	amount: z.coerce.number().finite().positive(),
	expenseDate: z.string().trim().min(1).optional(),
	expenseAccountCode: z.string().trim().min(1).optional(),
	fundingAccountCode: z.string().trim().min(1).optional(),
	eventId: z.string().trim().min(1).optional(),
	expenseCategoryId: z.string().trim().min(1).optional(),
	category: z.string().trim().min(1).optional(),
	description: z.string().trim().min(1).optional(),
	receiptImage: z.string().optional(),
});

export const expenseCategorySchema = z.object({
	code: z.string().trim().min(1),
	name: z.string().trim().min(1),
	description: z.string().trim().nullable().optional(),
	status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export const returnedExpenseSchema = expenseSchema.pick({
	amount: true,
	expenseDate: true,
	expenseCategoryId: true,
	description: true,
	receiptImage: true,
});
