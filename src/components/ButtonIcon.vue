<template>
  <!-- [播客改造] 屏蔽原生 hover tooltip（用户不喜欢，但 title 文案保留在调用处，
       后续如想恢复，把 inheritAttrs 改回 true，或在下方 filteredAttrs 里把 title 留下） -->
  <button class="button-icon" v-bind="filteredAttrs"><slot></slot></button>
</template>

<script>
export default {
  name: 'ButtonIcon',
  inheritAttrs: false,
  computed: {
    filteredAttrs() {
      const a = { ...this.$attrs };
      delete a.title;
      return a;
    },
  },
};
</script>

<style lang="scss" scoped>
button {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 8px;
  background: transparent;
  margin: 4px;
  border-radius: 25%;
  transition: 0.2s;
  .svg-icon {
    color: var(--color-text);
    height: 16px;
    width: 16px;
  }
  &:first-child {
    margin-left: 0;
  }
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  &:active {
    transform: scale(0.92);
  }
}
</style>
