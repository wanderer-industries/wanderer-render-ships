import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { bakeSkinnedMeshes } from './bake-skinned-meshes.js';
import { applyPhantomMaterials, restoreOriginalMaterials, type PhantomPreset } from './phantom-material.js';
import './styles.css';

interface RotationDegrees {
  pitch: number;
  yaw: number;
  roll: number;
}

type RenderMode = 'original' | 'phantom-gray' | 'wireframe';

const MODEL_BASE_URL =
  import.meta.env.VITE_MODEL_BASE_URL ??
  'https://raw.githubusercontent.com/EstamelGG/EVE_Model_Gallery/main/docs/models';
const DRACO_DECODER_PATH =
  import.meta.env.VITE_DRACO_DECODER_PATH ?? 'https://estamelgg.github.io/EVE_Model_Gallery/js/';
const SIDE_RIGHT_ROTATION: Readonly<RotationDegrees> = { pitch: -10, yaw: 90, roll: 0 };
const CAMERA_PADDING = 1.18;
const CAMERA_DISTANCE_MULTIPLIER = 3;
const BACKGROUND_COLOR = 0x071017;
const DEFAULT_TYPE_ID = '587';
const QUERY = new URLSearchParams(window.location.search);
const IS_TRANSPARENT_CAPTURE = QUERY.get('transparent') === '1';
const QUERY_MODEL_URL = QUERY.get('modelUrl');

const getRequiredElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
};

const canvas = getRequiredElement<HTMLCanvasElement>('viewport');
const statusElement = getRequiredElement<HTMLDivElement>('status');
const form = getRequiredElement<HTMLFormElement>('type-form');
const typeIdInput = getRequiredElement<HTMLInputElement>('type-id');
const modelUrlInput = getRequiredElement<HTMLInputElement>('model-url');
const modelFileInput = getRequiredElement<HTMLInputElement>('model-file');
const pitchInput = getRequiredElement<HTMLInputElement>('pitch');
const yawInput = getRequiredElement<HTMLInputElement>('yaw');
const rollInput = getRequiredElement<HTMLInputElement>('roll');
const pitchValue = getRequiredElement<HTMLOutputElement>('pitch-value');
const yawValue = getRequiredElement<HTMLOutputElement>('yaw-value');
const rollValue = getRequiredElement<HTMLOutputElement>('roll-value');
const renderModeSelect = getRequiredElement<HTMLSelectElement>('render-mode');

const scene = new THREE.Scene();
scene.background = IS_TRANSPARENT_CAPTURE ? null : new THREE.Color(BACKGROUND_COLOR);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
camera.position.set(0, 0.35, 5);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: IS_TRANSPARENT_CAPTURE,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.setClearColor(BACKGROUND_COLOR, IS_TRANSPARENT_CAPTURE ? 0 : 1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);

const modelRoot = new THREE.Group();
scene.add(modelRoot);
scene.add(new THREE.HemisphereLight(0xc9e8ff, 0x16212b, 2.4));

const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
keyLight.position.set(4, 6, 5);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0x8cdcff, 2.2);
rimLight.position.set(-5, 2, -4);
scene.add(rimLight);

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
dracoLoader.setDecoderConfig({ type: 'wasm' });

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);
let currentModel: THREE.Object3D | null = null;
let currentObjectUrl: string | null = null;

const setStatus = (message: string, isError = false): void => {
  statusElement.textContent = message;
  statusElement.classList.toggle('error', isError);
};

const getTypeModelUrl = (typeId: string): string => `${MODEL_BASE_URL}/${typeId}_lite.glb`;

const disposeMaterial = (material: THREE.Material): void => {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
};

const disposeObject = (object: THREE.Object3D): void => {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    if (Array.isArray(child.material)) child.material.forEach(disposeMaterial);
    else disposeMaterial(child.material);
  });
};

const clearModel = (): void => {
  if (currentModel) {
    restoreOriginalMaterials(currentModel);
    modelRoot.remove(currentModel);
    disposeObject(currentModel);
    currentModel = null;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
};

const applyRenderMode = (mode: RenderMode): void => {
  if (!currentModel) return;
  restoreOriginalMaterials(currentModel);
  if (mode === 'original') return;
  const preset: PhantomPreset = mode === 'wireframe' ? 'wireframe' : 'gray';
  applyPhantomMaterials(currentModel, preset);
};

const centerModel = (object: THREE.Object3D): void => {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) throw new Error('The model has no renderable geometry.');
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);
  object.updateMatrixWorld(true);
};

const fitCamera = (): void => {
  if (!currentModel) return;

  modelRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(modelRoot);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const aspect = Math.max(0.1, canvas.clientWidth / Math.max(1, canvas.clientHeight));
  const verticalSize = Math.max(size.y, size.x / aspect) * CAMERA_PADDING;
  const distance = Math.max(size.length() * CAMERA_DISTANCE_MULTIPLIER, 1);

  camera.left = (-verticalSize * aspect) / 2;
  camera.right = (verticalSize * aspect) / 2;
  camera.top = verticalSize / 2;
  camera.bottom = -verticalSize / 2;
  camera.near = Math.max(0.001, distance / 1000);
  camera.far = distance * 10;
  camera.position.set(center.x, center.y + size.y * 0.12, center.z + distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
};

const readRotation = (): RotationDegrees => ({
  pitch: Number(pitchInput.value),
  yaw: Number(yawInput.value),
  roll: Number(rollInput.value),
});

const updateRotationLabels = (rotation: RotationDegrees): void => {
  pitchValue.value = `${rotation.pitch}°`;
  yawValue.value = `${rotation.yaw}°`;
  rollValue.value = `${rotation.roll}°`;
};

const applyRotation = (rotation: RotationDegrees, shouldFit = true): void => {
  modelRoot.rotation.set(
    THREE.MathUtils.degToRad(rotation.pitch),
    THREE.MathUtils.degToRad(rotation.yaw),
    THREE.MathUtils.degToRad(rotation.roll),
  );
  updateRotationLabels(rotation);
  if (shouldFit) fitCamera();
};

const setRotationInputs = (rotation: RotationDegrees): void => {
  pitchInput.value = String(rotation.pitch);
  yawInput.value = String(rotation.yaw);
  rollInput.value = String(rotation.roll);
  applyRotation(rotation);
};

const loadModel = async (url: string, label: string): Promise<void> => {
  setStatus(`Loading ${label}…`);

  try {
    const gltf = await loader.loadAsync(url);
    clearModel();
    currentModel = gltf.scene;
    bakeSkinnedMeshes(currentModel);
    centerModel(currentModel);
    modelRoot.add(currentModel);
    applyRenderMode(renderModeSelect.value as RenderMode);
    applyRotation(readRotation());
    setStatus(`${label} loaded`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Failed to load ${label}: ${message}`, true);
  }
};

const loadTypeId = async (modelUrl?: string): Promise<void> => {
  const typeId = typeIdInput.value.trim();
  if (!/^\d+$/.test(typeId)) {
    setStatus('Type ID must be a positive integer.', true);
    return;
  }
  const url = modelUrl ?? getTypeModelUrl(typeId);
  modelUrlInput.value = url;
  await loadModel(url, `type ${typeId}`);
};

const resize = (): void => {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const needsResize = canvas.width !== Math.round(width * renderer.getPixelRatio());
  if (!needsResize) return;
  renderer.setSize(width, height, false);
  fitCamera();
};

const render = (): void => {
  resize();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(render);
};

const downloadPng = (): void => {
  renderer.render(scene, camera);
  const typeId = typeIdInput.value.trim() || 'ship';
  const link = document.createElement('a');
  link.download = `${typeId}-pose.png`;
  link.href = renderer.domElement.toDataURL('image/png');
  link.click();
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void loadTypeId();
});

getRequiredElement<HTMLButtonElement>('load-url').addEventListener('click', () => {
  const url = modelUrlInput.value.trim();
  if (!url) {
    setStatus('Enter a model URL first.', true);
    return;
  }
  void loadModel(url, 'custom URL');
});

modelFileInput.addEventListener('change', () => {
  const file = modelFileInput.files?.[0];
  if (!file) return;
  const objectUrl = URL.createObjectURL(file);
  currentObjectUrl = objectUrl;
  void loadModel(objectUrl, file.name);
});

for (const input of [pitchInput, yawInput, rollInput]) {
  input.addEventListener('input', () => applyRotation(readRotation()));
}

getRequiredElement<HTMLButtonElement>('side-right').addEventListener('click', () => {
  setRotationInputs(SIDE_RIGHT_ROTATION);
});
getRequiredElement<HTMLButtonElement>('fit').addEventListener('click', fitCamera);
getRequiredElement<HTMLButtonElement>('download').addEventListener('click', downloadPng);
renderModeSelect.addEventListener('change', () => {
  applyRenderMode(renderModeSelect.value as RenderMode);
});

const queryTypeId = QUERY.get('typeId');
const queryRenderMode = QUERY.get('mode');
if (queryRenderMode === 'phantom') renderModeSelect.value = 'phantom-gray';
if (queryRenderMode === 'original' || queryRenderMode === 'phantom-gray' || queryRenderMode === 'wireframe') {
  renderModeSelect.value = queryRenderMode;
}
document.body.classList.toggle('capture-mode', QUERY.get('capture') === '1');
typeIdInput.value = queryTypeId ?? DEFAULT_TYPE_ID;
updateRotationLabels(readRotation());
render();
void loadTypeId(QUERY_MODEL_URL ?? undefined);
