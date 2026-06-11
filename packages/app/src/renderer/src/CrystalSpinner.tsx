import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * A slowly spinning faceted crystal (three.js), shown while a game unpacks.
 * Transparent background so it sits on the white panel; cyan body with a white
 * edge lattice and a violet rim light for the FFXIII crystal look.
 */
export function CrystalSpinner({ size = 168 }: { size?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 4.4);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return; // WebGL unavailable — skip the crystal rather than crash the gate
    }
    renderer.setSize(size, size);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    // Elongated octahedron = a classic gem/crystal silhouette.
    const geo = new THREE.OctahedronGeometry(1, 0);
    geo.scale(0.78, 1.4, 0.78);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x49c6e6,
      metalness: 0.3,
      roughness: 0.12,
      flatShading: true,
      transparent: true,
      opacity: 0.9,
      emissive: 0x0c5d72,
      emissiveIntensity: 0.35,
    });
    const crystal = new THREE.Mesh(geo, mat);
    scene.add(crystal);

    // White facet-edge lattice.
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }),
    );
    crystal.add(edges);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0x8fe6ff, 1.2);
    key.position.set(2, 3, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9a6bff, 0.85);
    rim.position.set(-3, -1, -2);
    scene.add(rim);

    let raf = 0;
    let t = 0;
    const animate = () => {
      t += 0.01;
      crystal.rotation.y += 0.02;
      crystal.rotation.x = Math.sin(t) * 0.2;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      edges.geometry.dispose();
      (edges.material as THREE.Material).dispose();
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
    };
  }, [size]);

  return <div ref={ref} style={{ width: size, height: size }} className="mx-auto" />;
}
