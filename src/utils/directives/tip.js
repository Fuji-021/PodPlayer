// [优化2] 全局 hover tooltip 指令 v-tip —— 统一替换原生 title=(Electron 渲染的丑系统框)。
//   样式照 Navbar 的 .nas-tip(深色半透明圆角、无 border、淡入)。用法:
//     v-tip="'立即播放'"            元素上方弹
//     v-tip:bottom="'NAS 已连接'"   元素下方弹
//     v-tip="isFav ? '取消收藏':'收藏'"  响应式文案(update 钩子跟随)
//   实现:全局**单例**浮层挂 body、position:fixed → 既不被祖先 overflow 裁切、又不重复建 DOM。
//   纯 DOM/CSS,无依赖。空文案不显示。
let floater = null;

function ensureStyle() {
  if (document.getElementById('v-tip-style')) return;
  const s = document.createElement('style');
  s.id = 'v-tip-style';
  s.textContent =
    '.v-tip-floater{position:fixed;z-index:10000;pointer-events:none;white-space:nowrap;' +
    'font-size:12px;font-weight:500;line-height:1;color:#fff;background:rgba(38,38,42,.94);' +
    'padding:6px 10px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.2);' +
    'max-width:60vw;overflow:hidden;text-overflow:ellipsis;opacity:0;transform:translateY(-2px);' +
    'transition:opacity .15s ease,transform .15s ease;}' +
    '.v-tip-floater.show{opacity:1;transform:translateY(0);}';
  document.head.appendChild(s);
}

function getFloater() {
  ensureStyle();
  if (floater && document.body.contains(floater)) return floater;
  floater = document.querySelector('.v-tip-floater');
  if (floater) return floater;
  floater = document.createElement('div');
  floater.className = 'v-tip-floater';
  document.body.appendChild(floater);
  return floater;
}

function hide() {
  if (floater) floater.classList.remove('show');
}

function show(el, text, placement) {
  if (!text) return;
  const f = getFloater();
  f.textContent = text;
  f.classList.add('show'); // 先显示以便测量自身宽高
  const r = el.getBoundingClientRect();
  const fr = f.getBoundingClientRect();
  let left = r.left + r.width / 2 - fr.width / 2;
  let top = placement === 'bottom' ? r.bottom + 8 : r.top - fr.height - 8;
  // 视口夹取,避免溢出屏幕边缘
  left = Math.max(6, Math.min(left, window.innerWidth - fr.width - 6));
  if (top < 6) top = r.bottom + 8; // 上方放不下 → 翻到下方
  f.style.left = left + 'px';
  f.style.top = top + 'px';
  // 一滚动就收(长列表里 fixed 浮层不会跟随宿主)
  window.addEventListener('scroll', hide, { once: true, capture: true });
}

export default {
  bind(el, binding) {
    el.__vTip__ = {
      text: binding.value,
      placement: binding.arg || 'top',
      enter() {
        show(el, el.__vTip__.text, el.__vTip__.placement);
      },
      leave: hide,
    };
    el.addEventListener('mouseenter', el.__vTip__.enter);
    el.addEventListener('mouseleave', el.__vTip__.leave);
  },
  update(el, binding) {
    if (el.__vTip__) {
      el.__vTip__.text = binding.value; // 响应式文案(收藏/取消收藏、播放/暂停)
      el.__vTip__.placement = binding.arg || 'top';
    }
  },
  unbind(el) {
    if (el.__vTip__) {
      el.removeEventListener('mouseenter', el.__vTip__.enter);
      el.removeEventListener('mouseleave', el.__vTip__.leave);
      hide(); // 防"宿主已卸载但浮层还亮着"
      delete el.__vTip__;
    }
  },
};
