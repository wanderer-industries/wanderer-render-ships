import { ESI_BASE_URL, SHIP_CATEGORY_ID } from './constants.js';
import { mapWithConcurrency } from './concurrency.js';
import { fetchJson } from './http.js';
import type { ShipType } from './types.js';

interface EsiCategory {
  groups: number[];
  name: string;
  published: boolean;
}

interface EsiGroup {
  category_id: number;
  group_id: number;
  name: string;
  published: boolean;
  types: number[];
}

interface EsiName {
  category: string;
  id: number;
  name: string;
}

const ESI_DATASOURCE_QUERY = 'datasource=tranquility';
const NAMES_CHUNK_SIZE = 1_000;

const chunk = <T>(values: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const resolveNames = async (typeIds: number[]): Promise<Map<number, string>> => {
  const idChunks = chunk(typeIds, NAMES_CHUNK_SIZE);
  const responses = await mapWithConcurrency(idChunks, 3, (ids) =>
    fetchJson<EsiName[]>(`${ESI_BASE_URL}/universe/names/?${ESI_DATASOURCE_QUERY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ids),
    }),
  );

  return new Map(
    responses
      .flat()
      .filter((item) => item.category === 'inventory_type')
      .map((item) => [item.id, item.name]),
  );
};

export const discoverShipTypes = async (concurrency: number): Promise<ShipType[]> => {
  const category = await fetchJson<EsiCategory>(
    `${ESI_BASE_URL}/universe/categories/${SHIP_CATEGORY_ID}/?${ESI_DATASOURCE_QUERY}`,
  );
  const groups = await mapWithConcurrency(category.groups, concurrency, (groupId) =>
    fetchJson<EsiGroup>(`${ESI_BASE_URL}/universe/groups/${groupId}/?${ESI_DATASOURCE_QUERY}`),
  );
  const publishedGroups = groups.filter((group) => group.published && group.category_id === SHIP_CATEGORY_ID);
  const groupByTypeId = new Map<number, EsiGroup>();

  for (const group of publishedGroups) {
    for (const typeId of group.types) groupByTypeId.set(typeId, group);
  }

  const typeIds = [...groupByTypeId.keys()].sort((left, right) => left - right);
  const names = await resolveNames(typeIds);

  return typeIds
    .filter((typeId) => names.has(typeId))
    .map((typeId) => {
      const group = groupByTypeId.get(typeId);
      return {
        typeId,
        name: names.get(typeId) ?? `Type ${typeId}`,
        groupId: group?.group_id ?? null,
        groupName: group?.name ?? null,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
};

export const resolveShipTypeIds = async (typeIds: number[]): Promise<ShipType[]> => {
  const uniqueTypeIds = [...new Set(typeIds)].sort((left, right) => left - right);
  const names = await resolveNames(uniqueTypeIds);
  return uniqueTypeIds.map((typeId) => ({
    typeId,
    name: names.get(typeId) ?? `Type ${typeId}`,
    groupId: null,
    groupName: null,
  }));
};
