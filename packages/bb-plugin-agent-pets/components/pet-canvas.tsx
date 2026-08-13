import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { PetAction, PetSpecies } from "../src/pet-types";

interface PetCanvasProps {
  species: PetSpecies;
  action: PetAction | null;
  interactionKey: number;
}

interface PetPalette {
  fur: number;
  light: number;
  muzzle: number;
  nose: number;
  innerEar: number;
  ground: number;
}

interface PetRig {
  model: THREE.Group;
  head: THREE.Group;
  body: THREE.Object3D;
  tail: THREE.Object3D;
  ears: THREE.Object3D[];
  eyes: THREE.Object3D[];
  highlights: THREE.Object3D[];
  baseEarRotationZ: number[];
  baseBodyScaleY: number;
  baseTailRotationZ: number;
  materials: Set<THREE.Material>;
}

const palettes: Record<PetSpecies, PetPalette> = {
  dog: {
    fur: 0xb8754c,
    light: 0xd89a69,
    muzzle: 0xe2af7f,
    nose: 0x4a2e23,
    innerEar: 0x9d5b45,
    ground: 0xb9c9aa,
  },
  cat: {
    fur: 0x8e9696,
    light: 0xbac0bd,
    muzzle: 0xd8d2ca,
    nose: 0x805c62,
    innerEar: 0xd19b9e,
    ground: 0xc4cdbd,
  },
  capybara: {
    fur: 0xb9794f,
    light: 0xd59868,
    muzzle: 0xe0ad7d,
    nose: 0x553a2c,
    innerEar: 0x8c563c,
    ground: 0xbac9a6,
  },
};

function addSphere(
  parent: THREE.Object3D,
  geometry: THREE.SphereGeometry,
  material: THREE.Material,
  position: [number, number, number],
  scale: [number, number, number] = [1, 1, 1],
): THREE.Mesh {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(...position);
  object.scale.set(...scale);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

function addCylinder(
  parent: THREE.Object3D,
  geometry: THREE.CylinderGeometry,
  material: THREE.Material,
  position: [number, number, number],
  scale: [number, number, number] = [1, 1, 1],
): THREE.Mesh {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(...position);
  object.scale.set(...scale);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

function addMaterial(materials: Set<THREE.Material>, material: THREE.Material): THREE.Material {
  materials.add(material);
  return material;
}

function addCatWhisker(
  parent: THREE.Object3D,
  material: THREE.Material,
  position: [number, number, number],
  rotationZ: number,
): void {
  const whisker = addCylinder(
    parent,
    new THREE.CylinderGeometry(0.009, 0.009, 0.38, 8),
    material,
    position,
  );
  whisker.rotation.z = rotationZ;
  whisker.rotation.x = Math.PI / 2;
}

function createPet(species: PetSpecies): PetRig {
  const palette = palettes[species];
  const materials = new Set<THREE.Material>();
  const fur = addMaterial(materials, new THREE.MeshStandardMaterial({ color: palette.fur, roughness: 0.92 }));
  const light = addMaterial(materials, new THREE.MeshStandardMaterial({ color: palette.light, roughness: 0.9 }));
  const muzzle = addMaterial(materials, new THREE.MeshStandardMaterial({ color: palette.muzzle, roughness: 0.88 }));
  const nose = addMaterial(materials, new THREE.MeshStandardMaterial({ color: palette.nose, roughness: 0.78 }));
  const innerEar = addMaterial(materials, new THREE.MeshStandardMaterial({ color: palette.innerEar, roughness: 0.9 }));
  const eye = addMaterial(materials, new THREE.MeshStandardMaterial({ color: 0x211d1a, roughness: 0.22 }));
  const eyeHighlight = addMaterial(materials, new THREE.MeshBasicMaterial({ color: 0xfff7df }));

  const model = new THREE.Group();
  const body = addSphere(
    model,
    new THREE.SphereGeometry(1, 32, 20),
    fur,
    [0, 1.06, 0],
    species === "capybara" ? [1.3, 0.94, 0.92] : [1.2, 0.9, 0.86],
  );
  const chest = addSphere(model, new THREE.SphereGeometry(0.68, 28, 18), light, [0, 1.1, 0.65], [0.84, 0.92, 0.34]);
  chest.castShadow = true;

  const head = new THREE.Group();
  model.add(head);
  addSphere(head, new THREE.SphereGeometry(0.9, 32, 22), light, [0, 1.82, 0.1], species === "cat" ? [0.9, 0.94, 0.85] : [0.96, 0.92, 0.9]);

  if (species === "cat") {
    addSphere(head, new THREE.SphereGeometry(0.3, 24, 16), muzzle, [-0.18, 1.6, 0.78], [1, 0.82, 0.65]);
    addSphere(head, new THREE.SphereGeometry(0.3, 24, 16), muzzle, [0.18, 1.6, 0.78], [1, 0.82, 0.65]);
  } else {
    addSphere(head, new THREE.SphereGeometry(0.38, 24, 16), muzzle, [-0.2, 1.6, 0.83], [1, 0.85, 0.68]);
    addSphere(head, new THREE.SphereGeometry(0.38, 24, 16), muzzle, [0.2, 1.6, 0.83], [1, 0.85, 0.68]);
  }
  addSphere(head, new THREE.SphereGeometry(species === "cat" ? 0.12 : 0.2, 24, 16), nose, [0, 1.77, 1.04], [1.15, 0.72, 0.7]);

  const leftEye = addSphere(head, new THREE.SphereGeometry(0.11, 24, 16), eye, [-0.32, 1.98, 0.79]);
  const rightEye = addSphere(head, new THREE.SphereGeometry(0.11, 24, 16), eye, [0.32, 1.98, 0.79]);
  const leftHighlight = addSphere(head, new THREE.SphereGeometry(0.035, 12, 8), eyeHighlight, [-0.35, 2.02, 0.88]);
  const rightHighlight = addSphere(head, new THREE.SphereGeometry(0.035, 12, 8), eyeHighlight, [0.29, 2.02, 0.88]);

  const ears: THREE.Object3D[] = [];
  if (species === "cat") {
    const leftEar = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.62, 4), fur);
    leftEar.position.set(-0.54, 2.43, 0.02);
    leftEar.rotation.z = -0.18;
    leftEar.castShadow = true;
    head.add(leftEar);
    const rightEar = leftEar.clone();
    rightEar.position.x = 0.54;
    rightEar.rotation.z = 0.18;
    head.add(rightEar);
    addSphere(leftEar, new THREE.SphereGeometry(0.12, 16, 10), innerEar, [0, 0.03, 0.17], [0.8, 0.8, 0.32]);
    addSphere(rightEar, new THREE.SphereGeometry(0.12, 16, 10), innerEar, [0, 0.03, 0.17], [0.8, 0.8, 0.32]);
    ears.push(leftEar, rightEar);

    const whiskerMaterial = addMaterial(materials, new THREE.MeshBasicMaterial({ color: 0x5c605c }));
    addCatWhisker(head, whiskerMaterial, [-0.3, 1.62, 0.94], 0.16);
    addCatWhisker(head, whiskerMaterial, [-0.3, 1.56, 0.94], -0.04);
    addCatWhisker(head, whiskerMaterial, [0.3, 1.62, 0.94], -0.16);
    addCatWhisker(head, whiskerMaterial, [0.3, 1.56, 0.94], 0.04);
  } else {
    const earScale = species === "dog" ? [0.23, 0.44, 0.17] : [0.21, 0.25, 0.16];
    const leftEar = addSphere(head, new THREE.SphereGeometry(1, 22, 14), fur, [-0.57, species === "dog" ? 2.3 : 2.38, 0.02], earScale as [number, number, number]);
    const rightEar = addSphere(head, new THREE.SphereGeometry(1, 22, 14), fur, [0.57, species === "dog" ? 2.3 : 2.38, 0.02], earScale as [number, number, number]);
    leftEar.rotation.z = species === "dog" ? -0.34 : -0.12;
    rightEar.rotation.z = species === "dog" ? 0.34 : 0.12;
    ears.push(leftEar, rightEar);
  }

  const legPositions: Array<[number, number, number]> = [
    [-0.48, 0.56, 0.28],
    [0.48, 0.56, 0.28],
    [-0.45, 0.56, -0.3],
    [0.45, 0.56, -0.3],
  ];
  for (const [x, y, z] of legPositions) {
    addCylinder(model, new THREE.CylinderGeometry(0.18, 0.23, 0.7, 18), fur, [x, y, z]);
    addSphere(model, new THREE.SphereGeometry(0.24, 20, 12), fur, [x, 0.28, z + 0.08], [0.9, 0.48, 1.18]);
  }

  const tail = new THREE.Group();
  tail.position.set(0, 1.06, -0.9);
  model.add(tail);
  if (species === "cat") {
    addSphere(tail, new THREE.SphereGeometry(0.15, 18, 12), fur, [0, 0, 0], [1, 1.1, 1]);
    addSphere(tail, new THREE.SphereGeometry(0.14, 18, 12), fur, [0.1, 0.2, 0], [1, 1.4, 1]);
    addSphere(tail, new THREE.SphereGeometry(0.13, 18, 12), fur, [0.02, 0.4, 0], [1, 1.3, 1]);
    tail.rotation.z = -0.32;
  } else if (species === "dog") {
    addSphere(tail, new THREE.SphereGeometry(0.16, 18, 12), fur, [0, 0, 0], [1, 1.35, 1]);
    addSphere(tail, new THREE.SphereGeometry(0.13, 18, 12), fur, [0.1, 0.24, 0], [1, 1.3, 1]);
    tail.rotation.z = -0.55;
  } else {
    addSphere(tail, new THREE.SphereGeometry(0.14, 18, 12), fur, [0, 0, 0], [1.2, 0.9, 0.8]);
  }

  return {
    model,
    head,
    body,
    tail,
    ears,
    eyes: [leftEye, rightEye],
    highlights: [leftHighlight, rightHighlight],
    baseEarRotationZ: ears.map((ear) => ear.rotation.z),
    baseBodyScaleY: body.scale.y,
    baseTailRotationZ: tail.rotation.z,
    materials,
  };
}

export function PetCanvas({ species, action, interactionKey }: PetCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<PetAction | null>(action);
  const actionKeyRef = useRef(interactionKey);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => {
    actionRef.current = action;
    actionKeyRef.current = interactionKey;
  }, [action, interactionKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", "Animated 3D companion pet");
    canvas.className = "absolute inset-0 h-full w-full";
    host.appendChild(canvas);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    } catch {
      setFallback("This browser cannot render the 3D pet because WebGL is unavailable.");
      return () => canvas.remove();
    }

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(27, 1, 0.1, 100);
    camera.position.set(0, 1.55, 6.4);
    camera.lookAt(0, 1.18, 0);
    scene.add(new THREE.HemisphereLight(0xfff8e8, 0x68705a, 2.1));

    const keyLight = new THREE.DirectionalLight(0xfff4d9, 3.7);
    keyLight.position.set(-3.5, 6, 4.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -3;
    keyLight.shadow.camera.right = 3;
    keyLight.shadow.camera.top = 3;
    keyLight.shadow.camera.bottom = -3;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xc8d9bb, 1.3);
    fillLight.position.set(3, 2.5, 1);
    scene.add(fillLight);

    const palette = palettes[species];
    const groundMaterial = new THREE.MeshStandardMaterial({ color: palette.ground, roughness: 1 });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(3.1, 64), groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0.03;
    ground.receiveShadow = true;
    scene.add(ground);

    const rig = createPet(species);
    rig.model.position.y = 0.16;
    scene.add(rig.model);
    setFallback(null);

    const clock = new THREE.Clock();
    let frame = 0;
    let nextBlink = 2.4;
    let blinkUntil = 0;
    let nextLook = 0;
    let lookTarget = 0;
    let lookValue = 0;
    let seenActionKey = interactionKey;
    let actionStarted = 0;

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();

    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(host);
    if (!resizeObserver) window.addEventListener("resize", resize);

    const animate = () => {
      const delta = clock.getDelta();
      const elapsed = clock.elapsedTime;
      const currentAction = actionRef.current;
      if (actionKeyRef.current !== seenActionKey) {
        seenActionKey = actionKeyRef.current;
        actionStarted = elapsed;
      }

      if (!reducedMotion) {
        const breath = 1 + Math.sin(elapsed * 2.1) * 0.022;
        rig.body.scale.y = rig.baseBodyScaleY * breath;
        rig.model.position.y = 0.16 + Math.sin(elapsed * 1.25) * 0.024;
        if (elapsed > nextLook) {
          lookTarget = (Math.random() - 0.5) * 0.16;
          nextLook = elapsed + 3 + Math.random() * 3;
        }
        lookValue += (lookTarget - lookValue) * Math.min(1, delta * 2.8);
        rig.model.rotation.y = lookValue;
      }

      if (elapsed > nextBlink) {
        blinkUntil = elapsed + 0.13;
        nextBlink = elapsed + 2.5 + Math.random() * 4;
      }
      const blinking = elapsed < blinkUntil;
      rig.eyes.forEach((eye) => { eye.scale.y = blinking ? 0.14 : 1; });
      rig.highlights.forEach((highlight) => { highlight.visible = !blinking; });

      const actionElapsed = elapsed - actionStarted;
      const actionActive = Boolean(currentAction) && actionElapsed >= 0 && actionElapsed < (reducedMotion ? 0.45 : 2.2);
      if (actionActive && currentAction === "feed") {
        rig.head.rotation.x = Math.sin(elapsed * 8) * 0.07;
        rig.tail.rotation.y = Math.sin(elapsed * 8) * 0.22;
        rig.ears.forEach((ear, index) => {
          const baseRotation = rig.baseEarRotationZ[index] ?? 0;
          ear.rotation.z = baseRotation + (index === 0 ? -1 : 1) * Math.sin(elapsed * 8) * 0.006;
        });
      } else if (actionActive && currentAction === "talk") {
        rig.head.rotation.z = Math.sin(elapsed * 3.2) * 0.065;
        rig.tail.rotation.y = Math.sin(elapsed * 3.2) * 0.08;
        rig.ears.forEach((ear, index) => {
          const baseRotation = rig.baseEarRotationZ[index] ?? 0;
          ear.rotation.z += (baseRotation - ear.rotation.z) * 0.12;
        });
      } else {
        rig.head.rotation.x *= 0.9;
        rig.head.rotation.z *= 0.9;
        rig.tail.rotation.y *= 0.9;
        rig.tail.rotation.z += (rig.baseTailRotationZ - rig.tail.rotation.z) * 0.08;
        rig.ears.forEach((ear, index) => {
          const baseRotation = rig.baseEarRotationZ[index] ?? 0;
          ear.rotation.z += (baseRotation - ear.rotation.z) * 0.12;
        });
      }

      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", resize);
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
      });
      rig.materials.forEach((material) => material.dispose());
      ground.geometry.dispose();
      groundMaterial.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, [species]);

  return (
    <div ref={hostRef} className="absolute inset-0" aria-label={`${species} 3D pet model`}>
      {fallback ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
          {fallback}
        </div>
      ) : null}
    </div>
  );
}
