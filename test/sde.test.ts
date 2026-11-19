import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelIndexes, resolveModelTypeId, resolveVariationParent, type SdeTypeInfo } from '../src/sde.js';

const TYPES = new Map<number, SdeTypeInfo>([
  [
    641,
    {
      typeId: 641,
      graphicId: 64,
      hullName: 'gb2_t1',
      iconFolder: 'res:/dx9/model/ship/gallente/battleship/gb2/icons',
      published: true,
      variationParentTypeId: null,
    },
  ],
  [
    17740,
    {
      typeId: 17740,
      graphicId: 2157,
      hullName: 'gb2_t1',
      iconFolder: 'res:/dx9/model/ship/gallente/battleship/gb2/icons',
      published: true,
      variationParentTypeId: 641,
    },
  ],
  [
    28661,
    {
      typeId: 28661,
      graphicId: 3353,
      hullName: 'gb2_t2',
      iconFolder: 'res:/dx9/model/ship/gallente/battleship/gb2/icons',
      published: true,
      variationParentTypeId: 641,
    },
  ],
  [
    34237,
    {
      typeId: 34237,
      graphicId: 20942,
      hullName: 'gb2_t1',
      iconFolder: 'res:/dx9/model/ship/gallente/battleship/gb2/icons',
      published: false,
      variationParentTypeId: null,
    },
  ],
  [
    34241,
    {
      typeId: 34241,
      graphicId: 20944,
      hullName: 'gb2_t2',
      iconFolder: 'res:/dx9/model/ship/gallente/battleship/gb2/icons',
      published: false,
      variationParentTypeId: null,
    },
  ],
  [
    44996,
    {
      typeId: 44996,
      graphicId: 21864,
      hullName: 'conb1_t1',
      iconFolder: 'res:/dx9/model/ship/concord/battleship/conb1/icons',
      published: true,
      variationParentTypeId: null,
    },
  ],
  [
    85236,
    {
      typeId: 85236,
      graphicId: 27916,
      hullName: 'conb1_xx',
      iconFolder: 'res:/dx9/model/ship/concord/battleship/conb1/icons',
      published: true,
      variationParentTypeId: null,
    },
  ],
]);

test('variation parent resolves faction and tech variants to the base hull', () => {
  assert.equal(resolveVariationParent(17740, TYPES), 641);
  assert.equal(resolveVariationParent(28661, TYPES), 641);
});

test('SOF hull names resolve editions without a variation parent', () => {
  const modelIndexes = buildModelIndexes(TYPES);
  assert.equal(resolveModelTypeId(34237, TYPES, modelIndexes), 641);
  assert.equal(resolveModelTypeId(34241, TYPES, modelIndexes), 641);
});

test('icon folders resolve tournament reskins with distinct SOF hull names', () => {
  const modelIndexes = buildModelIndexes(TYPES);
  assert.equal(resolveModelTypeId(85236, TYPES, modelIndexes), 44996);
});
