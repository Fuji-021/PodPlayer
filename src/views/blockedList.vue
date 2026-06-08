<template>
  <!-- [B-47 第5点] 已屏蔽节目页：列出被屏蔽的节目，可取消屏蔽（恢复在发现页/统计页显示） -->
  <div class="blocked-list">
    <h1>已屏蔽节目</h1>
    <div v-if="!items.length" class="empty">
      还没有屏蔽任何节目。在首页发现页右键节目封面即可屏蔽。
    </div>
    <div v-else class="list">
      <div v-for="b in items" :key="b.name" class="row">
        <img
          v-if="b.coverUrl"
          class="cover"
          :src="b.coverUrl"
          loading="lazy"
          @error="onErr"
        />
        <div v-else class="cover placeholder"></div>
        <div class="name">{{ b.name }}</div>
        <button class="unblock" @click="unblock(b.name)">取消屏蔽</button>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'BlockedList',
  computed: {
    items() {
      return this.$store.state.podcastBlocked.items || [];
    },
  },
  methods: {
    unblock(name) {
      this.$store.commit('removeBlockedPodcast', name);
      this.$store.dispatch('showToast', '已取消屏蔽');
    },
    onErr(e) {
      e.target.style.opacity = 0.2;
    },
  },
};
</script>

<style lang="scss" scoped>
.blocked-list {
  color: var(--color-text);
  padding-top: 28px;
  h1 {
    font-size: 32px;
    font-weight: 700;
    margin: 0 0 24px;
  }
}
.empty {
  opacity: 0.5;
  padding: 60px 0;
  text-align: center;
  font-size: 14px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 8px;
  border-radius: 10px;
  transition: 0.15s;
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  .cover {
    width: 48px;
    height: 48px;
    border-radius: 8px;
    object-fit: cover;
    background: var(--color-secondary-bg);
    flex-shrink: 0;
  }
  .cover.placeholder {
    background: var(--color-secondary-bg);
  }
  .name {
    flex: 1;
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unblock {
    flex-shrink: 0;
    background: var(--color-secondary-bg);
    color: var(--color-text);
    font-size: 13px;
    font-weight: 600;
    padding: 7px 14px;
    border-radius: 8px;
    cursor: pointer;
    transition: 0.15s;
    &:hover {
      background: var(--color-primary);
      color: var(--color-primary-bg);
    }
  }
}
</style>
