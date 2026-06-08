<template>
  <!-- [B-48 第5点] 头像裁切：拖动+滚轮缩放，圆形视口，确定输出 1:1 dataURL。无第三方库。 -->
  <div class="cropper-mask" @click.self="$emit('cancel')">
    <div class="cropper">
      <div class="ch-title">裁剪头像</div>
      <div ref="vp" class="ch-vp" @mousedown="onDown" @wheel.prevent="onWheel">
        <img
          ref="img"
          :src="src"
          class="ch-img"
          :style="imgStyle"
          draggable="false"
          @load="onImgLoad"
        />
        <div class="ch-ring"></div>
      </div>
      <div class="ch-tip">拖动调整位置 · 滚轮缩放</div>
      <div class="ch-actions">
        <button class="btn-secondary" @click="$emit('cancel')">取消</button>
        <button class="btn-primary" @click="confirm">确定</button>
      </div>
    </div>
  </div>
</template>

<script>
const VP = 260; // 视口（=输出）边长
export default {
  name: 'AvatarCropper',
  props: {
    src: { type: String, required: true },
  },
  data() {
    return {
      natW: 0,
      natH: 0,
      scale: 1,
      minScale: 1,
      tx: 0,
      ty: 0,
      dragging: false,
      lastX: 0,
      lastY: 0,
      moveListener: null,
      upListener: null,
    };
  },
  computed: {
    imgStyle() {
      return {
        width: this.natW * this.scale + 'px',
        height: this.natH * this.scale + 'px',
        transform: `translate(${this.tx}px, ${this.ty}px)`,
      };
    },
  },
  beforeDestroy() {
    this.endDrag();
  },
  methods: {
    onImgLoad(e) {
      const img = e.target;
      this.natW = img.naturalWidth || 1;
      this.natH = img.naturalHeight || 1;
      // 短边填满视口的最小缩放（保证圆内无空白）
      this.minScale = VP / Math.min(this.natW, this.natH);
      this.scale = this.minScale;
      this.center();
    },
    center() {
      this.tx = (VP - this.natW * this.scale) / 2;
      this.ty = (VP - this.natH * this.scale) / 2;
    },
    // 拖动越界夹回：保证图始终盖满视口
    clamp() {
      const dw = this.natW * this.scale;
      const dh = this.natH * this.scale;
      this.tx = Math.min(0, Math.max(VP - dw, this.tx));
      this.ty = Math.min(0, Math.max(VP - dh, this.ty));
    },
    onDown(e) {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.moveListener = ev => this.onMove(ev);
      this.upListener = () => this.endDrag();
      document.addEventListener('mousemove', this.moveListener);
      document.addEventListener('mouseup', this.upListener);
    },
    onMove(e) {
      if (!this.dragging) return;
      this.tx += e.clientX - this.lastX;
      this.ty += e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.clamp();
    },
    endDrag() {
      this.dragging = false;
      if (this.moveListener) {
        document.removeEventListener('mousemove', this.moveListener);
        this.moveListener = null;
      }
      if (this.upListener) {
        document.removeEventListener('mouseup', this.upListener);
        this.upListener = null;
      }
    },
    onWheel(e) {
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      const next = Math.min(
        this.minScale * 6,
        Math.max(this.minScale, this.scale * factor)
      );
      if (next === this.scale) return;
      // 围绕视口中心缩放：保持中心点对应的图像位置不变
      const c = VP / 2;
      const px = (c - this.tx) / this.scale;
      const py = (c - this.ty) / this.scale;
      this.scale = next;
      this.tx = c - px * next;
      this.ty = c - py * next;
      this.clamp();
    },
    confirm() {
      const canvas = document.createElement('canvas');
      canvas.width = VP;
      canvas.height = VP;
      const ctx = canvas.getContext('2d');
      // 视口左上(0,0) 对应源图坐标，源区域边长 = VP/scale
      const sx = -this.tx / this.scale;
      const sy = -this.ty / this.scale;
      const s = VP / this.scale;
      ctx.drawImage(this.$refs.img, sx, sy, s, s, 0, 0, VP, VP);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      this.$emit('done', dataUrl);
    },
  },
};
</script>

<style lang="scss" scoped>
.cropper-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}
.cropper {
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 14px;
  padding: 24px 26px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
  align-items: center;
}
.ch-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 16px;
  align-self: flex-start;
}
.ch-vp {
  position: relative;
  width: 260px;
  height: 260px;
  overflow: hidden;
  border-radius: 12px;
  background: #000;
  cursor: grab;
  user-select: none;
  &:active {
    cursor: grabbing;
  }
}
.ch-img {
  position: absolute;
  left: 0;
  top: 0;
  max-width: none;
  -webkit-user-drag: none;
}
// 圆外暗化：内切圆透明，圆外半透明黑（box-shadow 扩散，被视口 overflow 裁切）
.ch-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.ch-tip {
  font-size: 12px;
  opacity: 0.55;
  margin-top: 12px;
}
.ch-actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
  align-self: flex-end;
}
.btn-primary,
.btn-secondary {
  font-weight: 600;
  font-size: 14px;
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  transition: 0.15s;
}
.btn-primary {
  background: var(--color-primary);
  color: var(--color-primary-bg);
  &:hover {
    transform: scale(1.04);
  }
}
.btn-secondary {
  background: var(--color-secondary-bg);
  color: var(--color-text);
  &:hover {
    background: var(--color-primary-bg-for-transparent);
  }
}
</style>
