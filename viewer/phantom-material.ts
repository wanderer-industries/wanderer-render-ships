import * as THREE from 'three';

type MeshMaterial = THREE.Material | THREE.Material[];

export type PhantomPreset = 'gray' | 'wireframe';

interface PhantomStyle {
  edgeThreshold: number;
  illumination: readonly [number, number, number];
  alpha: readonly [number, number, number, number, number];
  whiten: readonly [number, number, number];
  depthWrite: boolean;
  edgeOpacity: number;
  edgeBlending: THREE.Blending;
}

const EDGE_OBJECT_NAME = 'wanderer-phantom-edges';
const PHANTOM_COLOR = new THREE.Color(0xaeb7bb);
const EDGE_COLOR = new THREE.Color(0xdfe5e7);
const PHANTOM_STYLES: Readonly<Record<PhantomPreset, PhantomStyle>> = {
  gray: {
    edgeThreshold: 32,
    illumination: [0.3, 0.16, 0.28],
    alpha: [0.3, 0.04, 0.16, 0.22, 0.58],
    whiten: [0.55, 0.08, 0.68],
    depthWrite: true,
    edgeOpacity: 0.62,
    edgeBlending: THREE.AdditiveBlending,
  },
  wireframe: {
    edgeThreshold: 24,
    illumination: [0.34, 0.26, 0.54],
    alpha: [0.24, 0.08, 0.56, 0.24, 0.88],
    whiten: [0.72, 0.12, 0.82],
    depthWrite: false,
    edgeOpacity: 0.54,
    edgeBlending: THREE.AdditiveBlending,
  },
};
const PHANTOM_VERTEX_SHADER = `
  varying vec3 vWorldNormal;
  varying vec3 vViewDirection;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDirection = cameraPosition - worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;
const PHANTOM_FRAGMENT_SHADER = `
  uniform vec3 uColor;
  uniform vec3 uIllumination;
  uniform vec3 uAlphaFactors;
  uniform vec2 uAlphaRange;
  uniform vec3 uWhiten;
  varying vec3 vWorldNormal;
  varying vec3 vViewDirection;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDirection = normalize(vViewDirection);
    vec3 lightDirection = normalize(vec3(-0.35, 0.72, 0.58));
    float diffuse = max(dot(normal, lightDirection), 0.0);
    float rim = pow(1.0 - abs(dot(normal, viewDirection)), 1.55);
    float scanline = 0.98 + 0.02 * sin(gl_FragCoord.y * 1.65);
    float illumination = uIllumination.x + diffuse * uIllumination.y + rim * uIllumination.z;
    float alpha = clamp(
      (uAlphaFactors.x + diffuse * uAlphaFactors.y + rim * uAlphaFactors.z) * scanline,
      uAlphaRange.x,
      uAlphaRange.y
    );
    float whiten = clamp(rim * uWhiten.x + diffuse * uWhiten.y, 0.0, uWhiten.z);
    vec3 color = mix(uColor, vec3(1.0), whiten);
    gl_FragColor = vec4(color * illumination, alpha);
  }
`;

const originalMaterials = new WeakMap<THREE.Mesh, MeshMaterial>();

const disposeMaterial = (material: MeshMaterial): void => {
  if (Array.isArray(material)) {
    material.forEach((entry) => entry.dispose());
    return;
  }
  material.dispose();
};

const createPhantomMaterial = (style: PhantomStyle): THREE.ShaderMaterial => {
  const [baseIllumination, diffuseIllumination, rimIllumination] = style.illumination;
  const [baseAlpha, diffuseAlpha, rimAlpha, minimumAlpha, maximumAlpha] = style.alpha;
  const [rimWhiten, diffuseWhiten, maximumWhiten] = style.whiten;

  return new THREE.ShaderMaterial({
    name: 'WandererPhantomMaterial',
    uniforms: {
      uColor: { value: PHANTOM_COLOR },
      uIllumination: { value: new THREE.Vector3(baseIllumination, diffuseIllumination, rimIllumination) },
      uAlphaFactors: { value: new THREE.Vector3(baseAlpha, diffuseAlpha, rimAlpha) },
      uAlphaRange: { value: new THREE.Vector2(minimumAlpha, maximumAlpha) },
      uWhiten: { value: new THREE.Vector3(rimWhiten, diffuseWhiten, maximumWhiten) },
    },
    vertexShader: PHANTOM_VERTEX_SHADER,
    fragmentShader: PHANTOM_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: style.depthWrite,
    depthTest: true,
    side: THREE.FrontSide,
    blending: THREE.NormalBlending,
  });
};

const createEdges = (geometry: THREE.BufferGeometry, style: PhantomStyle): THREE.LineSegments => {
  const edgeGeometry = new THREE.EdgesGeometry(geometry, style.edgeThreshold);
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: EDGE_COLOR,
    transparent: true,
    opacity: style.edgeOpacity,
    depthWrite: false,
    depthTest: true,
    blending: style.edgeBlending,
  });
  const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edges.name = EDGE_OBJECT_NAME;
  edges.renderOrder = 3;
  return edges;
};

const getMeshes = (root: THREE.Object3D): THREE.Mesh[] => {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  return meshes;
};

export const restoreOriginalMaterials = (root: THREE.Object3D): void => {
  for (const mesh of getMeshes(root)) {
    const originalMaterial = originalMaterials.get(mesh);
    if (originalMaterial) {
      disposeMaterial(mesh.material);
      mesh.material = originalMaterial;
      originalMaterials.delete(mesh);
    }

    const edges = mesh.children.find((child) => child.name === EDGE_OBJECT_NAME);
    if (!(edges instanceof THREE.LineSegments)) continue;
    mesh.remove(edges);
    edges.geometry.dispose();
    disposeMaterial(edges.material);
  }
};

export const applyPhantomMaterials = (root: THREE.Object3D, preset: PhantomPreset = 'gray'): void => {
  restoreOriginalMaterials(root);
  const style = PHANTOM_STYLES[preset];

  for (const mesh of getMeshes(root)) {
    originalMaterials.set(mesh, mesh.material);
    mesh.material = createPhantomMaterial(style);
    mesh.add(createEdges(mesh.geometry, style));
  }
};
