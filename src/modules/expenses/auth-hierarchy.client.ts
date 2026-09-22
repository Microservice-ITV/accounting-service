type AuthShopUser = {
  id?: string | null;
  shop_id?: string | null;
  user?: { id?: string | null } | null;
  user_id?: string | null;
  status?: string | null;
};

type AuthManager = {
  level?: number | null;
  shopUserId?: string | null;
  userId?: string | null;
  name?: string | null;
};

type ManagerChainResponse = {
  shopUserId?: string | null;
  managers?: AuthManager[];
};

function authServiceUrl(path: string) {
  const baseUrl = (process.env.AUTH_SERVICE_BASE_URL ?? 'http://localhost:8000/api/v1').replace(/\/$/, '');
  return `${baseUrl}${path}`;
}

async function getAuthJson<T>(path: string, bearerToken: string, errorMessage: string): Promise<T> {
  let response: Response;

  try {
    response = await fetch(authServiceUrl(path), {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: 'application/json',
      },
    });
  } catch {
    throw new Error(errorMessage);
  }

  if (!response.ok) {
    throw new Error(errorMessage);
  }

  try {
    return await response.json() as T;
  } catch {
    throw new Error('Invalid Auth Service response');
  }
}

function unwrapData<T>(payload: { data?: T } | T): T {
  if (payload && typeof payload === 'object' && 'data' in payload && payload.data !== undefined) {
    return payload.data;
  }

  return payload as T;
}

function membershipUserId(member: AuthShopUser) {
  return member.user?.id ?? member.user_id ?? null;
}

export async function resolveManagerChainFromAuth(
  shopId: string,
  sellerUserId: string,
  bearerToken?: string,
): Promise<Map<number, string>> {
  if (!bearerToken) {
    throw new Error('Manager chain requires an Auth Service bearer token');
  }

  const membersPayload = await getAuthJson<{ data?: { users?: AuthShopUser[] }; users?: AuthShopUser[] }>(
    `/shops/${encodeURIComponent(shopId)}/users`,
    bearerToken,
    'Unable to load seller shop membership from Auth Service',
  );
  const membersData = unwrapData<{ users?: AuthShopUser[] }>(membersPayload);
  const members = Array.isArray(membersData?.users) ? membersData.users : [];
  const sellerMembership = members.find((member) => {
    const memberShopId = member.shop_id;
    return membershipUserId(member) === sellerUserId && (!memberShopId || memberShopId === shopId);
  });

  if (!sellerMembership?.id) {
    throw new Error('Seller shop membership was not found');
  }

  if (sellerMembership.status && sellerMembership.status !== 'active') {
    throw new Error('Seller shop membership is inactive');
  }

  const chainPayload = await getAuthJson<{ data?: ManagerChainResponse } & ManagerChainResponse>(
    `/shops/${encodeURIComponent(shopId)}/users/${encodeURIComponent(sellerMembership.id)}/manager-chain`,
    bearerToken,
    'Manager chain is unavailable from Auth Service',
  );
  const chain = unwrapData<ManagerChainResponse>(chainPayload);

  if (chain.shopUserId !== sellerMembership.id || !Array.isArray(chain.managers)) {
    throw new Error('Invalid manager-chain response from Auth Service');
  }

  const managerByLevel = new Map<number, string>();
  const memberByUserId = new Map(
    members
      .map((member) => [membershipUserId(member), member] as const)
      .filter(([userId]) => userId !== null),
  );

  chain.managers.forEach((manager, index) => {
    const expectedLevel = index + 1;
    const userId = manager.userId?.trim();
    const managerMembership = userId ? memberByUserId.get(userId) : undefined;

    if (
      manager.level !== expectedLevel
      || !manager.shopUserId
      || !userId
      || !managerMembership
      || managerMembership.id !== manager.shopUserId
      || (managerMembership.shop_id && managerMembership.shop_id !== shopId)
      || (managerMembership.status && managerMembership.status !== 'active')
      || managerByLevel.has(manager.level)
    ) {
      throw new Error('Invalid manager-chain response from Auth Service');
    }

    managerByLevel.set(manager.level, userId);
  });

  return managerByLevel;
}
