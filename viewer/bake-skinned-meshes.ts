import * as THREE from 'three';

const BAKED_VERTEX = new THREE.Vector3();
const SKIN_ATTRIBUTES = ['skinIndex', 'skinWeight'] as const;

const bakeGeometry = (mesh: THREE.SkinnedMesh): THREE.BufferGeometry => {
  const geometry = mesh.geometry.clone();
  const sourcePosition = geometry.getAttribute('position');
  const bakedPosition = new THREE.Float32BufferAttribute(sourcePosition.count * 3, 3);

  mesh.skeleton.update();
  for (let index = 0; index < sourcePosition.count; index += 1) {
    mesh.getVertexPosition(index, BAKED_VERTEX);
    bakedPosition.setXYZ(index, BAKED_VERTEX.x, BAKED_VERTEX.y, BAKED_VERTEX.z);
  }

  geometry.setAttribute('position', bakedPosition);
  for (const attribute of SKIN_ATTRIBUTES) geometry.deleteAttribute(attribute);
  geometry.deleteAttribute('normal');
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

const replaceWithStaticMesh = (mesh: THREE.SkinnedMesh): void => {
  const parent = mesh.parent;
  if (!parent) return;

  const staticMesh = new THREE.Mesh(mesh.geometry, mesh.material);
  staticMesh.copy(mesh, false);
  staticMesh.geometry = bakeGeometry(mesh);
  staticMesh.name = mesh.name;

  for (const child of [...mesh.children]) staticMesh.add(child);
  parent.remove(mesh);
  parent.add(staticMesh);
};

export const bakeSkinnedMeshes = (root: THREE.Object3D): number => {
  root.updateMatrixWorld(true);
  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) skinnedMeshes.push(object);
  });

  for (const mesh of skinnedMeshes) replaceWithStaticMesh(mesh);
  root.updateMatrixWorld(true);
  return skinnedMeshes.length;
};
