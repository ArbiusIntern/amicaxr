import * as THREE from "three";
import {
  computeBoundsTree,
  disposeBoundsTree,
  computeBatchedBoundsTree,
  disposeBatchedBoundsTree,
  acceleratedRaycast,
  MeshBVHHelper,
  StaticGeometryGenerator,
} from 'three-mesh-bvh';
import { GenerateMeshBVHWorker } from '@/workers/bvh/GenerateMeshBVHWorker';
import { WorkerBase } from '@/workers/bvh/utils/WorkerBase';
import GUI from 'lil-gui';
import Stats from 'stats.js';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { InteractiveGroup } from 'three/examples/jsm/interactive/InteractiveGroup.js';
import { HTMLMesh } from 'three/examples/jsm/interactive/HTMLMesh.js';

import { loadVRMAnimation } from "@/lib/VRMAnimation/loadVRMAnimation";
import { loadMixamoAnimation } from "@/lib/VRMAnimation/loadMixamoAnimation";
import { config } from "@/utils/config";

import { XRControllerModelFactory } from './XRControllerModelFactory';
import { XRHandModelFactory } from './XRHandModelFactory';
import { Model } from "./model";
import { Room } from "./room";

// Add the extension functions
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

THREE.BatchedMesh.prototype.computeBoundsTree = computeBatchedBoundsTree;
THREE.BatchedMesh.prototype.disposeBoundsTree = disposeBatchedBoundsTree;
THREE.BatchedMesh.prototype.raycast = acceleratedRaycast;


/**
 * three.jsを使った3Dビューワー
 *
 * setup()でcanvasを渡してから使う
 */
export class Viewer {
  public isReady: boolean;
  public model?: Model;
  public room?: Room;

  private _renderer?: THREE.WebGLRenderer;
  private _clock: THREE.Clock;
  private _scene: THREE.Scene;
  private _floor?: THREE.Mesh;
  private _camera?: THREE.PerspectiveCamera;
  private _cameraControls?: OrbitControls;
  private _stats?: Stats;
  private _statsMesh?: THREE.Mesh;


  private sendScreenshotToCallback: boolean;
  private screenshotCallback: BlobCallback | undefined;

  // XR
  public currentSession: XRSession | null = null;
  private cachedCameraPosition: THREE.Vector3 | null = null;
  private cachedCameraRotation: THREE.Euler | null = null;
  private hand1: THREE.Group | null = null;
  private hand2: THREE.Group | null = null;
  private controller1: THREE.Group | null = null;
  private controller2: THREE.Group | null = null;
  private usingController1 = false;
  private usingController2 = false;
  private controllerGrip1: THREE.Group | null = null;
  private controllerGrip2: THREE.Group | null = null;
  private isPinching1 = false;
  private isPinching2 = false;
  private currentHandModel: number = 0;
  private handModels: { left: THREE.Object3D[], right: THREE.Object3D[] } = { left: [], right: [] };
  private igroup: InteractiveGroup | null = null;

  private gparams = {
    'y-offset': 0,
    'hands': 0,
  };
  private updateMsPanel: any = null;
  private renderMsPanel: any = null;
  private modelMsPanel: any = null;
  private bvhMsPanel: any = null;
  private raycastMsPanel: any = null;
  private statsMsPanel: any = null;

  private bvhWorker: WorkerBase | null = null;
  private modelBVHGenerator: StaticGeometryGenerator | null = null;
  private modelGeometry: THREE.BufferGeometry | null = null;
  private modelMeshHelper: THREE.Mesh | null = null;
  private modelBVHHelper: MeshBVHHelper | null = null;
  private roomBVHHelperGroup: THREE.Group = new THREE.Group();

  private mouse = new THREE.Vector2();

  constructor() {
    this.isReady = false;
    this.sendScreenshotToCallback = false;
    this.screenshotCallback = undefined;

    // scene
    const scene = new THREE.Scene();
    this._scene = scene;

    // light
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
    directionalLight.position.set(1.0, 1.0, 1.0).normalize();
    scene.add(directionalLight);

    const ambientLight = new THREE.AmbientLight(0xffffff, 2.);
    scene.add(ambientLight);

    const floorGeometry = new THREE.PlaneGeometry(10, 10);
    const floorMaterial = new THREE.MeshBasicMaterial({
      color: 0xFFFFFF,
      side: THREE.DoubleSide,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    this._floor = floor;
    floor.rotation.x = Math.PI / 2;
    floor.visible = false;
    scene.add(floor);

    scene.add(this.roomBVHHelperGroup);

    // animate
    this._clock = new THREE.Clock();
    this._clock.start();
  }

  public getCanvas() {
    return this._renderer?.domElement?.parentElement?.getElementsByTagName("canvas")[0];
  }

  public async onSessionStarted(session: XRSession, immersiveType: XRSessionMode) {
    if (! this._renderer) {
      return;
    }
    console.log('session', session);

    const canvas = this.getCanvas();
    // TODO this needs to be set to none to prevent double render breaking the compositing
    // except on desktop using emulator, then it should not be changed
    // canvas!.style.display = "none";

    this.cachedCameraPosition = this._camera?.position.clone() as THREE.Vector3;
    this.cachedCameraRotation = this._camera?.rotation.clone() as THREE.Euler;

    this._renderer.xr.setReferenceSpaceType('local');
    await this._renderer.xr.setSession(session);

    this.teleport(0, -1.2, 0);

    if (immersiveType === 'immersive-vr') {
      this._floor!.visible = true;
    }

    this.currentSession = session;
    this.currentSession.addEventListener('end', () => this.onSessionEnded());
  }

  public onSessionEnded(/*event*/) {
    if (! this) {
      console.error('onSessionEnded called without this');
      return;
    }
    if (! this.currentSession) {
      return;
    }

    // reset camera
    this._camera?.position.copy(this.cachedCameraPosition as THREE.Vector3);
    this._camera?.rotation.copy(this.cachedCameraRotation as THREE.Euler);

    const canvas = this.getCanvas();
    canvas!.style.display = "inline";

    this.currentSession.removeEventListener('end', this.onSessionEnded);
    this.currentSession = null;

    this._floor!.visible = false;

    requestAnimationFrame(() => {
      this.resetCamera();
    });
  }

  public teleport(x: number, y: number, z: number) {
    if (!this._renderer) {
      return;
    }
    if (!this._renderer.xr) {
      return;
    }
    if (!this._renderer.xr.isPresenting) {
      return;
    }

    const baseReferenceSpace = this._renderer.xr.getReferenceSpace();
    if (baseReferenceSpace) {
      const offsetPosition = { x, y, z, w: 1, };
      const offsetRotation = new THREE.Quaternion();
      // offsetRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
      const transform = new XRRigidTransform(offsetPosition, offsetRotation);
      const teleportSpaceOffset = baseReferenceSpace.getOffsetReferenceSpace(transform);

      this._renderer.xr.setReferenceSpace(teleportSpaceOffset);
    }
  }

  public loadVrm(url: string) {
    if (this.model?.vrm) {
      this.unloadVRM();
    }

    // gltf and vrm
    this.model = new Model(this._camera || new THREE.Object3D());
    return this.model.loadVRM(url).then(async () => {
      if (!this.model?.vrm) return;

      // build bvh
      this.modelBVHGenerator = new StaticGeometryGenerator(this.model.vrm.scene);
      // this.modelBVHGenerator.attributes = ['position', 'normal']
      // this.modelBVHGenerator.useGroups = false
      this.modelGeometry = this.modelBVHGenerator.generate().center();

      // TODO show during debug mode
      const wireframeMaterial = new THREE.MeshBasicMaterial( {
        wireframe:   true,
        transparent: true,
        opacity:     0.05,
        depthWrite:  false,
      });
      this.modelMeshHelper = new THREE.Mesh(new THREE.BufferGeometry(), wireframeMaterial);
      if (config("debug_gfx") === "true") {
        this._scene.add(this.modelMeshHelper);
      }

      this.modelBVHHelper = new MeshBVHHelper(this.modelMeshHelper);
      if (config("debug_gfx") === "true") {
        this._scene.add(this.modelBVHHelper);
      }

      this._scene.add(this.model.vrm.scene);

      const animation = config("animation_url").indexOf("vrma") > 0
        ? await loadVRMAnimation(config("animation_url"))
        : await loadMixamoAnimation(config("animation_url"), this.model?.vrm);
      if (animation) {
        await this.model.loadAnimation(animation);
        this.model.update(0);
      }

      await this.regenerateBVHForModel();

      // HACK: Adjust the camera position after playback because the origin of the animation is offset
      requestAnimationFrame(() => {
        this.resetCamera();
      });
    });
  }

  // TODO use the bvh worker to generate the bvh / bounds tree
  // TODO run this in its own loop to keep the bvh in sync with animation
  // TODO investigate if we can get speedup using parallel bvh generation
  public async regenerateBVHForModel() {
    if (! this.modelMeshHelper || ! this.modelBVHGenerator || ! this.modelBVHHelper) {
      return;
    }

    this.modelBVHGenerator.generate(this.modelMeshHelper.geometry);

    if (! this.modelMeshHelper.geometry.boundsTree) {
      this.modelMeshHelper.geometry.computeBoundsTree();
    } else {
      this.modelMeshHelper.geometry.boundsTree.refit();
    }

    this.modelBVHHelper.update();
  }

  public unloadVRM(): void {
    if (this.model?.vrm) {
      this._scene.remove(this.model.vrm.scene);
      // TODO if we don't dispose and create a new geometry then it seems like the performance gets slower
      {
        const geometry = this.modelMeshHelper?.geometry;
        geometry?.dispose();
        for (const key in geometry?.attributes) {
          geometry?.deleteAttribute(key);
        }
        this._scene.remove(this.modelMeshHelper as THREE.Object3D);
        this._scene.remove(this.modelBVHHelper as THREE.Object3D);
      }
      this.model?.unLoadVrm();
    }
  }

  public loadRoom(url: string) {
    if (this.room?.room) {
      this.unloadRoom();
    }

    this.room = new Room();
    return this.room.loadRoom(url).then(async () => {
      if (!this.room?.room) return;

      const roomYOffset = 1.2;

      this.room.room.position.set(0, roomYOffset, 0);
      this._scene.add(this.room.room);

      // build bvh
      for (let child of this.room.room.children) {
        if (child instanceof THREE.Mesh) {
          // this must be cloned because the worker breaks rendering for some reason
          const geometry = child.geometry.clone() as THREE.BufferGeometry;
          const bvh = await this.bvhWorker!.generate(geometry, { maxLeafTris: 1 })!;
          child.geometry.boundsTree = bvh;

          if (config("debug_gfx") === "true") {
            const helper = new MeshBVHHelper(child, bvh);
            helper.color.set(0xE91E63);
            this.roomBVHHelperGroup.add(helper)
          }
        }
      }

      this._scene.add(this.roomBVHHelperGroup);
    });
  }

  public unloadRoom(): void {
    if (this.room?.room) {
      this._scene.remove(this.room.room);
      // TODO if we don't dispose and create a new geometry then it seems like the performance gets slower
      for (const item of this.roomBVHHelperGroup.children) {
        if (item instanceof MeshBVHHelper) {
          try {
            // @ts-ignore
            const geometry = item.geometry;
            geometry?.dispose();
            for (const key in geometry?.attributes) {
              geometry?.deleteAttribute(key);
            }
          } catch (e) {
            console.error('error disposing room geometry', e);
          }
        }
      }
      this._scene.remove(this.roomBVHHelperGroup);
    }
  }

  // probably too slow to use
  // but fun experiment. maybe some use somewhere for tiny splats ?
  public loadSplat(url: string) {
    if (! this.room) {
      this.room = new Room();
    }
    return this.room.loadSplat(url).then(async () => {
      console.log('splat loaded');
      if (!this.room?.splat) return;

      this.room.splat.position.set(0, 4, 0);
      this.room.splat.rotation.set(0, 0, Math.PI);
      this._scene.add(this.room.splat);
    });
  }

  /**
   * Reactで管理しているCanvasを後から設定する
   */
  public async setup(canvas: HTMLCanvasElement) {
    console.log('setup canvas');
    const parentElement = canvas.parentElement;
    const width = parentElement?.clientWidth || canvas.width;
    const height = parentElement?.clientHeight || canvas.height;

    let WebRendererType = THREE.WebGLRenderer;
    if (config('use_webgpu') === 'true') {
      // @ts-ignore
      WebRendererType = (await import("three/src/renderers/webgpu/WebGPURenderer.js")).default;
    }

    this._renderer = new WebRendererType({
      canvas: canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    }) as THREE.WebGLRenderer;
    this._renderer.setSize(width, height);
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.xr.enabled = true;

    // webgpu does not support foveation yet
    if (config('use_webgpu') !== 'true') {
      this._renderer.xr.setFoveation(0);
    }

    // camera
    this._camera = new THREE.PerspectiveCamera(20.0, width / height, 0.1, 20.0);
    this._camera.position.set(0, -3, -3.5);
    this._cameraControls?.target.set(0, 4.3, 0);
    this._cameraControls?.update();
    // camera controls
    this._cameraControls = new OrbitControls(
      this._camera,
      this._renderer.domElement
    );

    this._cameraControls.screenSpacePanning = true;

    this._cameraControls.minDistance = 0.5;
    this._cameraControls.maxDistance = 8;

    this._cameraControls.update();

    // check if controller is available
    try {
      this.controller1 = this._renderer.xr.getController(0);
      this._scene.add(this.controller1);
      this.controller2 = this._renderer.xr.getController(1);
      this._scene.add(this.controller2);

      // @ts-ignore
      this.controller1.addEventListener('connected', (event) => {
        this.usingController1 = true;
      });
      // @ts-ignore
      this.controller2.addEventListener('connected', (event) => {
        this.usingController2 = true;
      });

      console.log('controller1', this.controller1);
      console.log('controller2', this.controller2);

      const controllerModelFactory = new XRControllerModelFactory();
      const handModelFactory = new XRHandModelFactory();

      this.controllerGrip1 = this._renderer.xr.getControllerGrip(0);
      this.controllerGrip1.add(controllerModelFactory.createControllerModel(this.controllerGrip1));
      this._scene.add(this.controllerGrip1);

      this.controllerGrip2 = this._renderer.xr.getControllerGrip(1);
      this.controllerGrip2.add(controllerModelFactory.createControllerModel(this.controllerGrip2));
      this._scene.add(this.controllerGrip2);

      this.hand1 = this._renderer.xr.getHand(0);
      this._scene.add(this.hand1);

      this.hand2 = this._renderer.xr.getHand(1);
      this._scene.add(this.hand2);

      this.handModels.left = [
        handModelFactory.createHandModel(this.hand1, 'boxes'),
        handModelFactory.createHandModel(this.hand1, 'spheres'),
        handModelFactory.createHandModel(this.hand1, 'mesh')
      ];

      this.handModels.right = [
        handModelFactory.createHandModel(this.hand2, 'boxes'),
        handModelFactory.createHandModel(this.hand2, 'spheres'),
        handModelFactory.createHandModel(this.hand2, 'mesh')
      ];

      for (let i=0; i<3; ++i) {
        {
          const model = this.handModels.left[i];
          model.visible = i == this.currentHandModel;
          this.hand1.add(model);
        }

        {
          const model = this.handModels.right[i];
          model.visible = i == this.currentHandModel;
          this.hand2.add(model);
        }
      }

      // @ts-ignore
      this.hand1.addEventListener('pinchstart', () => {
        this.isPinching1 = true;
      });
      // @ts-ignore
      this.hand2.addEventListener('pinchstart', () => {
        this.isPinching2 = true;
      });

      // @ts-ignore
      this.hand1.addEventListener('pinchend', () => {
        this.isPinching1 = false;
      });
      // @ts-ignore
      this.hand2.addEventListener('pinchend', () => {
        this.isPinching2 = false;
      });

      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1)
      ]);

      const line = new THREE.Line(geometry);
      line.name = 'line';
      line.scale.z = 5;

      this.controller1.add(line.clone());
      this.controller2.add(line.clone());
    } catch (e) {
      console.log("No controller available", e);
    }

    this.igroup = new InteractiveGroup();
    const igroup = this.igroup;
    igroup.listenToPointerEvents(this._renderer, this._camera);
    // webgpu does not support xr controller events yet
    if (config('use_webgpu') !== 'true') {
      // @ts-ignore
      igroup.listenToXRControllerEvents(this.controller1);
    }
    if (config('use_webgpu') !== 'true') {
      // @ts-ignore
      igroup.listenToXRControllerEvents(this.controller2);
    }
    igroup.position.set(-0.25, 1.3, -0.8);
    igroup.rotation.set(0, Math.PI / 8, 0);
    this._scene.add(igroup);

    // gui
    const gui = new GUI();
    let updateDebounceId: ReturnType<typeof setTimeout>|null = null;
    gui.add(this.gparams, 'y-offset', -0.2, 0.2).onChange((value: number) => {
      if (updateDebounceId) {
        clearTimeout(updateDebounceId);
      }

      updateDebounceId = setTimeout(() => {
        this.teleport(0, value, 0);
        this.gparams['y-offset'] = 0;
      }, 1000);
    });

    gui.add(this.gparams, 'hands', 0, 2, 1).onChange((value: number) => {
      this.handModels.left[this.currentHandModel].visible = false;
      this.handModels.right[this.currentHandModel].visible = false;

      this.currentHandModel = value;

      this.handModels.left[this.currentHandModel].visible = true;
      this.handModels.right[this.currentHandModel].visible = true;
    });

    // gui.domElement.style.visibility = 'hidden';

    const guiMesh = new HTMLMesh(gui.domElement);
    guiMesh.position.x = 0;
    guiMesh.position.y = 0;
    guiMesh.position.z = 0;
    guiMesh.scale.setScalar(2);
    igroup.add(guiMesh);


    // stats
    this._stats = new Stats();
    this._stats.dom.style.width = '80px';
    this._stats.dom.style.height = '48px';
    this._stats.dom.style.position = 'absolute';
    this._stats.dom.style.top = '0px';
    this._stats.dom.style.left = window.innerWidth - 80 + 'px';

    this.updateMsPanel  = this._stats.addPanel(new Stats.Panel('update_ms', '#fff', '#221'));
    this.renderMsPanel  = this._stats.addPanel(new Stats.Panel('render_ms', '#ff8', '#221'));
    this.modelMsPanel   = this._stats.addPanel(new Stats.Panel('model_ms', '#f8f', '#212'));
    this.bvhMsPanel     = this._stats.addPanel(new Stats.Panel('bvh_ms', '#8ff', '#122'));
    this.raycastMsPanel = this._stats.addPanel(new Stats.Panel('raycast_ms', '#f8f', '#212'));
    this.statsMsPanel   = this._stats.addPanel(new Stats.Panel('stats_ms', '#8f8', '#212'));


    document.body.appendChild(this._stats.dom);

    this._statsMesh = new HTMLMesh(this._stats.dom);
    this._statsMesh.position.x = 0;
    this._statsMesh.position.y = 0.25;
    this._statsMesh.position.z = 0;
    this._statsMesh.scale.setScalar(2.5);
    igroup.add(this._statsMesh);

    this.bvhWorker = new GenerateMeshBVHWorker();

    window.addEventListener("resize", () => {
      this.resize();
    });

    canvas.addEventListener("mousemove", (event) => {
      this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    });

    this.isReady = true;
    this._renderer.setAnimationLoop(() => {
      this.update();
    });
  }

  public onSelect(event: XRInputSourceEvent) {
    console.log('onSelect', event);
    console.log('onSelect', event.inputSource);
    console.log('onSelect', event.inputSource.hand);
    console.log('onSelect', event.inputSource.handedness);
    console.log('onSelect', event.inputSource.gripSpace);
    console.log('onSelect', event.inputSource.targetRayMode);
    console.log('onSelect', event.inputSource.targetRaySpace);
  }

  public doublePinchHandler() {
    if (! this.igroup || ! this._renderer || !this.controller1 || !this.controller2) {
      return;
    }

    const cam = this._renderer.xr.getCamera();

    const avgControllerPos = new THREE.Vector3()
      .addVectors(this.controller1.position, this.controller2.position)
      .multiplyScalar(0.5);

    const directionToControllers = new THREE.Vector3()
      .subVectors(avgControllerPos, cam.position)
      .normalize();

    const controller1Distance = cam.position.distanceTo(this.controller1.position);
    const controller2Distance = cam.position.distanceTo(this.controller2.position);
    const avgControllerDistance = (controller1Distance + controller2Distance) / 2;

    const distanceScale = 1;
    const d = 0.7 + (avgControllerDistance * distanceScale);

    const pos = new THREE.Vector3()
      .addVectors(cam.position, directionToControllers.multiplyScalar(d));

    this.igroup.position.copy(pos);
    this.igroup.lookAt(cam.position);
  }

  /**
   * canvasの親要素を参照してサイズを変更する
   */
  public resize() {
    if (!this._renderer) return;

    const parentElement = this._renderer.domElement.parentElement;
    if (!parentElement) return;

    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setSize(
      parentElement.clientWidth,
      parentElement.clientHeight
    );

    if (!this._camera) return;
    this._camera.aspect =
      parentElement.clientWidth / parentElement.clientHeight;
    this._camera.updateProjectionMatrix();
  }

  public resizeChatMode(on: boolean){
    if (!this._renderer) return;

    const parentElement = this._renderer.domElement.parentElement;
    if (!parentElement) return;

    this._renderer.setPixelRatio(window.devicePixelRatio);

    let width = parentElement.clientWidth;
    let height = parentElement.clientHeight;
    if (on) {width = width/2; height = height/2; }

    this._renderer.setSize(
      width,
      height
    );

    if (!this._camera) return;
    this._camera.aspect =
      parentElement.clientWidth / parentElement.clientHeight;
    this._camera.updateProjectionMatrix();
  }

  /**
   * VRMのheadノードを参照してカメラ位置を調整する
   */
  public resetCamera() {
    const headNode = this.model?.vrm?.humanoid.getNormalizedBoneNode("head");

    if (headNode) {
      const headWPos = headNode.getWorldPosition(new THREE.Vector3());
      this._camera?.position.set(
        this._camera.position.x,
        headWPos.y,
        this._camera.position.z
      );
      this._cameraControls?.target.set(headWPos.x, headWPos.y, headWPos.z);
      this._cameraControls?.update();
    }
  }

  public resetCameraLerp() {
    // y = 1.3 is from initial setup position of camera
    const newPosition = new THREE.Vector3(
      this._camera?.position.x,
      1.3,
      this._camera?.position.z
    );
    this._camera?.position.lerpVectors(this._camera?.position,newPosition,0);
    // this._cameraControls?.target.lerpVectors(this._cameraControls?.target,headWPos,0.5);
    // this._cameraControls?.update();
  }

  public hslToRgb(h: number, s: number, l: number) {
    let r, g, b;

    if (s == 0) {
      r = g = b = l; // achromatic
    } else {
      function hue2rgb(p: number, q: number, t: number) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      }

      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;

      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }

    return parseInt(`0x`+[r * 255, g * 255, b * 255 ].map(Math.floor).map(v => v.toString(16).padStart(2, '0')).join(''));
  }

  // itype: 0 = amica, 1 = room
  public createBallAtPoint(point: THREE.Vector3, itype: number = 0) {
    const distance = point.distanceTo(this._camera?.position as THREE.Vector3);
    const s = 5;
    const h = (distance * s) - Math.floor(distance * s);

    const getAmicaColor = () => {
      return this.hslToRgb(h, 1, 0.5);
    }
    const getRoomColor = () => {
      return this.hslToRgb(h, 0.1, 0.4);
    }

    const color = itype == 0 ? getAmicaColor() : getRoomColor();

    const ballMaterial = new THREE.MeshBasicMaterial({
      color,
    });

    const ballGeometry = new THREE.SphereGeometry(0.005, 16, 16);
    const ball = new THREE.Mesh(ballGeometry, ballMaterial);
    ball.position.copy(point);
    this._scene.add(ball);

    setTimeout(() => {
      this._scene.remove(ball);
    }, 10000);

  }

  public updateRaycasts() {
    if (! this._camera || ! this.model || ! this.room) {
      return;
    }

    const modelTargets: THREE.Mesh[] = [];
    const roomTargets: THREE.Mesh[] = [];

    if (this.modelMeshHelper) {
      modelTargets.push(this.modelMeshHelper);
    }

    if (this.room && this.room.room) {
      for (const child of this.room.room.children) {
        if (child instanceof THREE.Mesh) {
          roomTargets.push(child);
        }
      }
    }

    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    const raycasterTempM = new THREE.Matrix4();

    const checkIntersection = () => {
      let intersectsModel = [];
      let intersectsRoom = [];
      try {
        intersectsModel = raycaster.intersectObjects(modelTargets, true);
        intersectsRoom = raycaster.intersectObjects(roomTargets, true);
      } catch (e) {
        // if the models get removed from scene during raycast then this will throw an error
        console.error('intersectObjects error', e);
        return;
      }

      // check which object is closer
      if (intersectsModel.length > 0 && intersectsRoom.length > 0) {
        if (intersectsModel[0].distance < intersectsRoom[0].distance) {
          this.createBallAtPoint(intersectsModel[0].point, 0);
        } else {
          this.createBallAtPoint(intersectsRoom[0].point, 1);
        }
      } else if (intersectsModel.length > 0) {
        this.createBallAtPoint(intersectsModel[0].point, 0);
      } else if (intersectsRoom.length > 0) {
        this.createBallAtPoint(intersectsRoom[0].point, 1);
      }
    }

    if (! this.usingController1 && ! this.usingController2) {
      raycaster.setFromCamera(this.mouse, this._camera);
      checkIntersection();
    }

    const handleController = (controller: THREE.Group) => {
      raycasterTempM.identity().extractRotation(controller.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(raycasterTempM);

      checkIntersection();
    }

    if (this.controller1) handleController(this.controller1);
    if (this.controller2) handleController(this.controller2);
  }

  public update(time?: DOMHighResTimeStamp, frame?: XRFrame) {
    const delta = this._clock.getDelta();

    let utime = performance.now();

    let ptime = performance.now();
    if (this.model) {
      this.model.update(delta);
    }
    this.modelMsPanel.update(performance.now() - ptime, 40);

    if (this._renderer && this._camera) {
      ptime = performance.now();
      this._renderer.render(this._scene, this._camera);
      this.renderMsPanel.update(performance.now() - ptime, 100);

      ptime = performance.now();
      if (this._stats) {
        this._stats.update();
      }
      if (this._statsMesh) {
        // @ts-ignore
        this._statsMesh.material.map.update();
      }
      this.statsMsPanel.update(performance.now() - ptime, 100);


      if (this.room?.splat) {
        // this.room.splat.update(this._renderer, this._camera);
        // this.room.splat.render();
      }

      if (this.isPinching1 && this.isPinching2) {
        this.doublePinchHandler();
      }

      // TODO run this in a web worker
      // ideally parallel version
      ptime = performance.now();
      // this.regenerateBVHForModel();
      this.bvhMsPanel.update(performance.now() - ptime, 100);

      ptime = performance.now();
      this.updateRaycasts();
      this.raycastMsPanel.update(performance.now() - ptime, 100);

      if (this.sendScreenshotToCallback && this.screenshotCallback) {
        this._renderer.domElement.toBlob(this.screenshotCallback, "image/jpeg");
        this.sendScreenshotToCallback = false;

      }
    }

    this.updateMsPanel.update(performance.now() - utime, 40);
  }

  public getScreenshotBlob = (callback: BlobCallback) => {
    this.screenshotCallback = callback;
    this.sendScreenshotToCallback = true;
  };
}
