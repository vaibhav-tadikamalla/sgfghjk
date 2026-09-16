/**
 * NetworkCanvas — Scroll-driven 3D particle network.
 *
 * Two modes:
 *   "formation"  – particles start scattered, coalesce into a mesh, edges appear
 *   "chaos"      – stable mesh → nodes die → connections sever → self-healing
 *
 * The `progress` ref (0..1) drives all animation through useFrame.
 */

import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, Float } from '@react-three/drei';
import * as THREE from 'three';

// ─── Constants ─────────────────────────────────────────────────────────────
const NODE_COUNT = 70;
const SPHERE_RADIUS = 3.8;
const EDGE_DISTANCE_THRESHOLD = 2.2;
const PHI = (1 + Math.sqrt(5)) / 2;

// ─── Seeded random for deterministic scattering ────────────────────────────
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ─── Generate node data ────────────────────────────────────────────────────
function generateNodes() {
  const rng = seededRandom(42);

  // Target positions: Fibonacci sphere
  const targets: THREE.Vector3[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    const y = 1 - (i / (NODE_COUNT - 1)) * 2;
    const radiusAtY = Math.sqrt(1 - y * y);
    const theta = (2 * Math.PI * i) / PHI;
    targets.push(
      new THREE.Vector3(
        Math.cos(theta) * radiusAtY * SPHERE_RADIUS,
        y * SPHERE_RADIUS,
        Math.sin(theta) * radiusAtY * SPHERE_RADIUS
      )
    );
  }

  // Scattered positions: random in large cube
  const scattered: THREE.Vector3[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    scattered.push(
      new THREE.Vector3(
        (rng() - 0.5) * 20,
        (rng() - 0.5) * 20,
        (rng() - 0.5) * 20
      )
    );
  }

  // Edges: connect nodes within distance threshold (on target positions)
  const edges: [number, number][] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    for (let j = i + 1; j < NODE_COUNT; j++) {
      if (targets[i].distanceTo(targets[j]) < EDGE_DISTANCE_THRESHOLD) {
        edges.push([i, j]);
      }
    }
  }

  // Which nodes "die" during chaos (30% of nodes)
  const chaosVictims = new Set<number>();
  for (let i = 0; i < NODE_COUNT; i++) {
    if (rng() < 0.3) chaosVictims.add(i);
  }

  return { targets, scattered, edges, chaosVictims };
}

// ─── Particle Nodes ────────────────────────────────────────────────────────
function Particles({
  progress,
  mode,
  mouseRef,
}: {
  progress: React.MutableRefObject<number>;
  mode: 'formation' | 'chaos';
  mouseRef: React.MutableRefObject<{ x: number; y: number }>;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const data = useMemo(generateNodes, []);

  // Temp objects for instanced mesh
  const tempObj = useMemo(() => new THREE.Object3D(), []);
  const tempColor = useMemo(() => new THREE.Color(), []);

  // Pre-allocate color array
  const colorArray = useMemo(
    () => new Float32Array(NODE_COUNT * 3),
    []
  );

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const p = progress.current;

    for (let i = 0; i < NODE_COUNT; i++) {
      let pos: THREE.Vector3;
      let scale = 1;
      let r = 0.16, g = 0.47, b = 1.0; // accent-blue

      if (mode === 'formation') {
        // Lerp from scattered to target based on progress
        const lerpFactor = THREE.MathUtils.smoothstep(p, 0.1, 0.55);
        pos = data.scattered[i].clone().lerp(data.targets[i], lerpFactor);

        // Slight float wobble when formed
        if (lerpFactor > 0.9) {
          const time = Date.now() * 0.001;
          pos.y += Math.sin(time + i * 0.5) * 0.05;
        }

        // Node scale: fade in from 0.3 to 1
        scale = THREE.MathUtils.lerp(0.3, 1, THREE.MathUtils.smoothstep(p, 0.0, 0.3));

        // Color shifts cyan as they settle
        if (lerpFactor > 0.5) {
          const cyanMix = (lerpFactor - 0.5) * 2;
          r = THREE.MathUtils.lerp(0.16, 0.0, cyanMix * 0.3);
          g = THREE.MathUtils.lerp(0.47, 0.9, cyanMix * 0.3);
          b = 1.0;
        }
      } else {
        // Chaos mode
        pos = data.targets[i].clone();
        const isVictim = data.chaosVictims.has(i);

        if (isVictim) {
          // Death phase (0.2..0.5): shrink, turn red
          const deathProgress = THREE.MathUtils.smoothstep(p, 0.15, 0.45);
          // Heal phase (0.6..0.9): grow back, turn green then blue
          const healProgress = THREE.MathUtils.smoothstep(p, 0.6, 0.9);

          if (healProgress > 0) {
            scale = THREE.MathUtils.lerp(0, 1, healProgress);
            r = THREE.MathUtils.lerp(0.06, 0.16, healProgress);
            g = THREE.MathUtils.lerp(0.73, 0.47, healProgress * 0.5);
            b = THREE.MathUtils.lerp(0.33, 1.0, healProgress);
          } else {
            scale = THREE.MathUtils.lerp(1, 0, deathProgress);
            r = THREE.MathUtils.lerp(0.16, 0.96, deathProgress);
            g = THREE.MathUtils.lerp(0.47, 0.16, deathProgress);
            b = THREE.MathUtils.lerp(1.0, 0.24, deathProgress);
          }

          // Jitter during chaos peak
          if (p > 0.3 && p < 0.6 && scale > 0.1) {
            pos.x += (Math.random() - 0.5) * 0.15;
            pos.y += (Math.random() - 0.5) * 0.15;
            pos.z += (Math.random() - 0.5) * 0.15;
          }
        } else {
          // Healthy nodes glow brighter during chaos as they compensate
          if (p > 0.3 && p < 0.7) {
            scale = 1.15;
            g = 0.6;
          }
          // Float wobble
          const time = Date.now() * 0.001;
          pos.y += Math.sin(time + i * 0.5) * 0.04;
        }
      }

      tempObj.position.copy(pos);
      tempObj.scale.setScalar(scale * 0.08);
      tempObj.updateMatrix();
      mesh.setMatrixAt(i, tempObj.matrix);

      tempColor.setRGB(r, g, b);
      tempColor.toArray(colorArray, i * 3);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    else {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colorArray, 3);
    }
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, NODE_COUNT]}>
      <sphereGeometry args={[1, 16, 16]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

// ─── Edges ─────────────────────────────────────────────────────────────────
function Edges({
  progress,
  mode,
}: {
  progress: React.MutableRefObject<number>;
  mode: 'formation' | 'chaos';
}) {
  const groupRef = useRef<THREE.Group>(null);
  const data = useMemo(generateNodes, []);

  // Limit to max 120 edges for performance
  const visibleEdges = useMemo(() => data.edges.slice(0, 120), [data.edges]);

  // Create line objects imperatively to avoid SVG type collision
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    // Clear previous children
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
    }

    visibleEdges.forEach(([a, b]) => {
      const posA = mode === 'formation' ? data.scattered[a] : data.targets[a];
      const posB = mode === 'formation' ? data.scattered[b] : data.targets[b];

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(
          new Float32Array([
            posA.x, posA.y, posA.z,
            posB.x, posB.y, posB.z,
          ]),
          3
        )
      );

      const material = new THREE.LineBasicMaterial({
        color: 0x2979FF,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });

      const line = new THREE.Line(geometry, material);
      group.add(line);
    });

    return () => {
      while (group.children.length) {
        const child = group.children[0] as THREE.Line;
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
        group.remove(child);
      }
    };
  }, [visibleEdges, mode, data]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const p = progress.current;

    visibleEdges.forEach((edge, idx) => {
      const lineObj = group.children[idx] as THREE.Line | undefined;
      if (!lineObj) return;

      const [a, b] = edge;

      if (mode === 'formation') {
        // Edges fade in after nodes form (0.4..0.7)
        const edgeOpacity = THREE.MathUtils.smoothstep(p, 0.4, 0.7);
        const lerpFactor = THREE.MathUtils.smoothstep(p, 0.1, 0.55);

        const posA = data.scattered[a].clone().lerp(data.targets[a], lerpFactor);
        const posB = data.scattered[b].clone().lerp(data.targets[b], lerpFactor);

        const positions = lineObj.geometry.attributes.position;
        if (positions) {
          (positions.array as Float32Array).set([
            posA.x, posA.y, posA.z,
            posB.x, posB.y, posB.z,
          ]);
          positions.needsUpdate = true;
        }

        (lineObj.material as THREE.LineBasicMaterial).opacity = edgeOpacity * 0.35;
      } else {
        // Chaos mode
        const aVictim = data.chaosVictims.has(a);
        const bVictim = data.chaosVictims.has(b);
        const affected = aVictim || bVictim;

        let opacity = 0.35;
        if (affected) {
          const deathP = THREE.MathUtils.smoothstep(p, 0.15, 0.45);
          const healP = THREE.MathUtils.smoothstep(p, 0.6, 0.9);
          opacity = healP > 0
            ? THREE.MathUtils.lerp(0, 0.35, healP)
            : THREE.MathUtils.lerp(0.35, 0, deathP);
        }

        (lineObj.material as THREE.LineBasicMaterial).opacity = opacity;

        // Update positions (targets are fixed in chaos mode)
        const positions = lineObj.geometry.attributes.position;
        if (positions) {
          (positions.array as Float32Array).set([
            data.targets[a].x, data.targets[a].y, data.targets[a].z,
            data.targets[b].x, data.targets[b].y, data.targets[b].z,
          ]);
          positions.needsUpdate = true;
        }
      }
    });
  });

  return <group ref={groupRef} />;
}

// ─── Data Packets (small bright spheres that travel along edges) ───────────
function DataPackets({
  progress,
  mode,
}: {
  progress: React.MutableRefObject<number>;
  mode: 'formation' | 'chaos';
}) {
  const data = useMemo(generateNodes, []);
  const packetCount = 20;
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const tempObj = useMemo(() => new THREE.Object3D(), []);

  // Pick random edges for packets
  const packetEdges = useMemo(() => {
    const edges = data.edges.slice(0, 100);
    const selected: number[] = [];
    for (let i = 0; i < packetCount; i++) {
      selected.push(i % edges.length);
    }
    return selected;
  }, [data.edges]);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const p = progress.current;
    const time = clock.getElapsedTime();

    // Only show packets when network is formed
    const showPackets =
      mode === 'formation'
        ? p > 0.6
        : p < 0.2 || p > 0.8;

    for (let i = 0; i < packetCount; i++) {
      if (!showPackets) {
        tempObj.scale.setScalar(0);
        tempObj.updateMatrix();
        mesh.setMatrixAt(i, tempObj.matrix);
        continue;
      }

      const edgeIdx = packetEdges[i];
      const [a, b] = data.edges[edgeIdx] || [0, 1];
      const t = ((time * 0.4 + i * 0.3) % 1); // 0..1 parametric along edge

      const posA = data.targets[a];
      const posB = data.targets[b];
      const pos = posA.clone().lerp(posB, t);

      tempObj.position.copy(pos);
      tempObj.scale.setScalar(0.04);
      tempObj.updateMatrix();
      mesh.setMatrixAt(i, tempObj.matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, packetCount]}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial color="#00E5FF" toneMapped={false} />
    </instancedMesh>
  );
}

// ─── Background floating particles ────────────────────────────────────────
function BackgroundDust() {
  const ref = useRef<THREE.Points>(null);
  const count = 300;

  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 30;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 30;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 30;
    }
    return arr;
  }, []);

  useFrame(({ clock }) => {
    if (ref.current) {
      ref.current.rotation.y = clock.getElapsedTime() * 0.015;
      ref.current.rotation.x = Math.sin(clock.getElapsedTime() * 0.01) * 0.1;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.03}
        color="#ffffff"
        transparent
        opacity={0.2}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

// ─── Camera controller with mouse parallax ─────────────────────────────────
function CameraRig({
  mouseRef,
}: {
  mouseRef: React.MutableRefObject<{ x: number; y: number }>;
}) {
  const { camera } = useThree();
  const targetPos = useRef(new THREE.Vector3(0, 0, 12));

  useFrame(() => {
    // Subtle parallax from mouse
    const tx = mouseRef.current.x * 1.0;
    const ty = mouseRef.current.y * 0.5;

    targetPos.current.x += (tx - targetPos.current.x) * 0.03;
    targetPos.current.y += (ty - targetPos.current.y) * 0.03;

    camera.position.x = targetPos.current.x;
    camera.position.y = targetPos.current.y;
    camera.position.z = 12;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

// ─── Chaos shockwave ring ──────────────────────────────────────────────────
function ShockwaveRing({
  progress,
}: {
  progress: React.MutableRefObject<number>;
}) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (!ref.current) return;
    const p = progress.current;

    // Show shockwave during chaos peak (0.3..0.5)
    if (p > 0.25 && p < 0.55) {
      const wave = THREE.MathUtils.smoothstep(p, 0.25, 0.55);
      ref.current.scale.setScalar(wave * 8);
      (ref.current.material as THREE.MeshBasicMaterial).opacity =
        (1 - wave) * 0.4;
      ref.current.visible = true;
    } else {
      ref.current.visible = false;
    }
  });

  return (
    <mesh ref={ref} rotation={[Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.9, 1, 64]} />
      <meshBasicMaterial
        color="#F43F5E"
        transparent
        opacity={0}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

// ─── Healing pulse ring ────────────────────────────────────────────────────
function HealPulse({
  progress,
}: {
  progress: React.MutableRefObject<number>;
}) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (!ref.current) return;
    const p = progress.current;

    if (p > 0.6 && p < 0.9) {
      const heal = THREE.MathUtils.smoothstep(p, 0.6, 0.9);
      ref.current.scale.setScalar(heal * 7);
      (ref.current.material as THREE.MeshBasicMaterial).opacity =
        (1 - heal) * 0.3;
      ref.current.visible = true;
    } else {
      ref.current.visible = false;
    }
  });

  return (
    <mesh ref={ref} rotation={[Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.9, 1, 64]} />
      <meshBasicMaterial
        color="#10B981"
        transparent
        opacity={0}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

// ─── Main exported component ───────────────────────────────────────────────
interface NetworkCanvasProps {
  progress: React.MutableRefObject<number>;
  mode: 'formation' | 'chaos';
  className?: string;
}

export default function NetworkCanvas({
  progress,
  mode,
  className = '',
}: NetworkCanvasProps) {
  const mouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      mouseRef.current = {
        x: (e.clientX / window.innerWidth) * 2 - 1,
        y: -((e.clientY / window.innerHeight) * 2 - 1),
      };
    };
    window.addEventListener('mousemove', handler, { passive: true });
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  return (
    <div className={`absolute inset-0 ${className}`}>
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [0, 0, 12], fov: 50 }}
        gl={{
          antialias: true,
          alpha: true,
          powerPreference: 'high-performance',
        }}
        style={{ background: 'transparent' }}
      >
        <color attach="background" args={['#030303']} />
        <fog attach="fog" args={['#030303', 14, 28]} />

        <CameraRig mouseRef={mouseRef} />
        <BackgroundDust />
        <Particles progress={progress} mode={mode} mouseRef={mouseRef} />
        <Edges progress={progress} mode={mode} />
        <DataPackets progress={progress} mode={mode} />

        {mode === 'chaos' && (
          <>
            <ShockwaveRing progress={progress} />
            <HealPulse progress={progress} />
          </>
        )}

        <ambientLight intensity={0.3} />
      </Canvas>
    </div>
  );
}
