<template>
  <span
    class="subscription-episode-cover"
    :class="{ 'is-overlay-settled': episodeSettled }"
  >
    <span class="episode-cover-placeholder" aria-hidden="true">
      <svg-icon icon-class="radio-alt" />
    </span>
    <img
      v-if="baseSrc && !baseFailed"
      ref="baseImage"
      :key="baseKey"
      class="episode-cover-image episode-cover-base"
      :class="{ 'is-ready': baseReady }"
      :src="baseSrc"
      alt=""
      loading="eager"
      decoding="async"
      :data-cover-token="requestToken"
      :data-cover-source="baseSrc"
      @load="onBaseLoad"
      @error="onBaseError"
    />
    <img
      v-if="episodeSrc"
      ref="episodeImage"
      :key="episodeKey"
      class="episode-cover-image episode-cover-overlay"
      :class="{
        'is-ready': episodeReady,
        'is-instant': !episodeAnimate,
      }"
      :src="episodeSrc"
      alt=""
      loading="eager"
      decoding="async"
      :data-cover-token="requestToken"
      :data-cover-source="episodeSrc"
      @load="onEpisodeLoad"
      @error="onEpisodeError"
      @transitionend="onEpisodeTransitionEnd"
    />
  </span>
</template>

<script>
import SvgIcon from '@/components/SvgIcon.vue';
import {
  cacheCoverFromImg,
  getCachedCover,
  peekCachedCover,
} from '@/utils/podcast/coverCache';
import {
  createSubscriptionEpisodeCoverPlan,
  getSubscriptionEpisodeCoverFailureState,
  getSubscriptionEpisodeCoverReadyState,
  isCurrentSubscriptionEpisodeCoverRequest,
  normalizeSubscriptionEpisodeCoverUrl,
  resolveSubscriptionEpisodeCoverSource,
  resolveSubscriptionPodcastCoverSource,
  shouldPersistSubscriptionEpisodeCover,
  SUBSCRIPTION_EPISODE_COVER_SOURCES,
} from '@/utils/podcast/subscriptionEpisodeCover';
import {
  cancelSubscriptionEpisodeCoverPersistence,
  enqueueSubscriptionEpisodeCoverPersistence,
} from '@/utils/podcast/subscriptionEpisodeCoverPersistence';

function isReducedMotion() {
  return !!(
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function decodeImage(image) {
  if (!image || !image.complete || !image.naturalWidth) {
    return Promise.resolve(false);
  }
  if (typeof image.decode !== 'function') return Promise.resolve(true);
  try {
    return image.decode().then(
      () => true,
      () => false
    );
  } catch (e) {
    return Promise.resolve(false);
  }
}

export default {
  name: 'SubscriptionEpisodeCover',
  components: { SvgIcon },
  props: {
    episode: { type: Object, required: true },
  },
  data() {
    return {
      requestToken: 0,
      requestEpisodeId: '',
      currentPlan: null,
      baseSrc: '',
      baseSource: SUBSCRIPTION_EPISODE_COVER_SOURCES.NONE,
      baseFailed: false,
      baseReady: false,
      baseResolved: false,
      episodeSrc: '',
      episodeSource: SUBSCRIPTION_EPISODE_COVER_SOURCES.NONE,
      episodeDecoded: false,
      episodeReady: false,
      episodeAnimate: false,
      episodeSettled: false,
    };
  },
  computed: {
    baseKey() {
      return this.requestToken + ':base:' + this.baseSrc;
    },
    episodeKey() {
      return this.requestToken + ':episode:' + this.episodeSrc;
    },
  },
  watch: {
    episode: {
      handler() {
        this.resetCover();
      },
      immediate: true,
    },
  },
  activated() {
    this._coverActive = true;
    this.resetCover();
  },
  deactivated() {
    this._coverActive = false;
    this.invalidateRequests();
  },
  beforeDestroy() {
    this._coverActive = false;
    this.invalidateRequests();
  },
  methods: {
    invalidateRequests() {
      this.cancelCoverCachePersistence();
      this.requestToken += 1;
    },
    isCurrentRequest(token, episodeId) {
      return isCurrentSubscriptionEpisodeCoverRequest({
        token: token,
        currentToken: this.requestToken,
        episodeId: episodeId,
        currentEpisodeId: this.requestEpisodeId,
      });
    },
    getCoverCacheTasks() {
      if (!this._coverCacheTasks) this._coverCacheTasks = [];
      return this._coverCacheTasks;
    },
    cancelCoverCachePersistence() {
      const tasks = this.getCoverCacheTasks().slice();
      this._coverCacheTasks = [];
      tasks.forEach(task => {
        task.canceled = true;
        cancelSubscriptionEpisodeCoverPersistence(task.ticket);
        task.ticket = null;
      });
    },
    isCurrentCoverCacheTask(task) {
      if (!task || task.canceled || this._coverActive === false) return false;
      const isBase = task.layer === 'base';
      const currentUrl = isBase ? this.baseSrc : this.episodeSrc;
      const currentSource = isBase ? this.baseSource : this.episodeSource;
      const currentImage = isBase
        ? this.$refs.baseImage
        : this.$refs.episodeImage;
      return (
        this.isCurrentRequest(task.token, task.episodeId) &&
        task.url === currentUrl &&
        task.source === currentSource &&
        task.image === currentImage &&
        !!task.image.naturalWidth
      );
    },
    scheduleCoverCachePersistence({
      layer,
      token,
      episodeId,
      url,
      source,
      image,
    }) {
      if (!url || !image || !shouldPersistSubscriptionEpisodeCover(source)) {
        return;
      }
      const task = {
        layer,
        token,
        episodeId,
        url,
        source,
        image,
        canceled: false,
        ticket: null,
      };
      task.ticket = enqueueSubscriptionEpisodeCoverPersistence({
        url: task.url,
        isValid: () => this.isCurrentCoverCacheTask(task),
        persist: () => {
          if (!this.isCurrentCoverCacheTask(task)) return;
          try {
            cacheCoverFromImg(task.url, task.image);
          } catch (e) {
            // Cover persistence is an idle best effort; rendering is already ready.
          }
        },
        onSettled: () => {
          const tasks = this.getCoverCacheTasks();
          const index = tasks.indexOf(task);
          if (index >= 0) tasks.splice(index, 1);
        },
      });
      if (!task.ticket) return;
      this.getCoverCacheTasks().push(task);
    },
    resetCover() {
      this.cancelCoverCachePersistence();
      const token = this.requestToken + 1;
      this.requestToken = token;
      this.requestEpisodeId = String((this.episode && this.episode.id) || '');
      const podcastUrl = (this.episode && this.episode.podcastCoverUrl) || '';
      const episodeUrl = (this.episode && this.episode.episodeCoverUrl) || '';
      const normalizedPodcastUrl =
        normalizeSubscriptionEpisodeCoverUrl(podcastUrl);
      const normalizedEpisodeUrl =
        normalizeSubscriptionEpisodeCoverUrl(episodeUrl);
      const plan = createSubscriptionEpisodeCoverPlan({
        episodeId: this.requestEpisodeId,
        episodeCoverUrl: episodeUrl,
        podcastCoverUrl: podcastUrl,
        memoryEpisodeCover: peekCachedCover(normalizedEpisodeUrl),
        memoryPodcastCover: peekCachedCover(normalizedPodcastUrl),
        reducedMotion: isReducedMotion(),
      });
      this.currentPlan = plan;
      const initialPodcast = resolveSubscriptionPodcastCoverSource(plan, '');
      const initialEpisode = resolveSubscriptionEpisodeCoverSource(plan, '');
      this.baseSrc = plan.memoryPodcastUrl ? initialPodcast.src : '';
      this.baseSource = this.baseSrc
        ? initialPodcast.source
        : SUBSCRIPTION_EPISODE_COVER_SOURCES.NONE;
      this.baseFailed = false;
      this.baseReady = false;
      this.baseResolved = !plan.shouldLookupPodcastCache;
      this.episodeSrc = plan.memoryEpisodeUrl ? initialEpisode.src : '';
      this.episodeSource = this.episodeSrc
        ? initialEpisode.source
        : SUBSCRIPTION_EPISODE_COVER_SOURCES.NONE;
      // Even a data URL can fail to decode. Memory hits remain instant, but only
      // become visible after their actual image element has been validated.
      this.episodeDecoded = false;
      this.episodeReady = false;
      this.episodeAnimate = false;
      this.episodeSettled = false;

      if (this.baseSrc) this.checkBaseImage(token, this.baseSrc);
      if (this.episodeSrc) this.checkEpisodeImage(token, this.episodeSrc);
      if (plan.shouldLookupPodcastCache) {
        this.resolveBaseFromCache(plan, token);
      }
      if (plan.shouldLookupEpisodeCache) {
        this.resolveEpisodeFromCache(plan, token);
      }
    },
    resolveBaseFromCache(plan, token) {
      getCachedCover(plan.podcastUrl)
        .then(data => {
          if (!this.isCurrentRequest(token, plan.episodeId)) return;
          const resolved = resolveSubscriptionPodcastCoverSource(plan, data);
          this.baseSrc = resolved.src;
          this.baseSource = resolved.source;
          this.baseFailed = false;
          this.baseResolved = true;
          this.checkBaseImage(token, this.baseSrc);
        })
        .catch(() => {
          if (!this.isCurrentRequest(token, plan.episodeId)) return;
          this.baseSrc = plan.podcastUrl;
          this.baseSource = SUBSCRIPTION_EPISODE_COVER_SOURCES.REMOTE;
          this.baseFailed = false;
          this.baseResolved = true;
          this.checkBaseImage(token, this.baseSrc);
        });
    },
    resolveEpisodeFromCache(plan, token) {
      getCachedCover(plan.episodeUrl)
        .then(data => {
          if (!this.isCurrentRequest(token, plan.episodeId)) return;
          const resolved = resolveSubscriptionEpisodeCoverSource(plan, data);
          this.episodeSrc = resolved.src;
          this.episodeSource = resolved.source;
          this.episodeDecoded = false;
          this.episodeReady = false;
          this.episodeAnimate = false;
          this.episodeSettled = false;
          this.checkEpisodeImage(token, this.episodeSrc);
        })
        .catch(() => {
          if (!this.isCurrentRequest(token, plan.episodeId)) return;
          this.episodeSrc = plan.episodeUrl;
          this.episodeSource = SUBSCRIPTION_EPISODE_COVER_SOURCES.REMOTE;
          this.episodeDecoded = false;
          this.episodeReady = false;
          this.episodeAnimate = false;
          this.episodeSettled = false;
          this.checkEpisodeImage(token, this.episodeSrc);
        });
    },
    checkBaseImage(token, source) {
      this.$nextTick(() => {
        const image = this.$refs.baseImage;
        if (!image || !this.isCurrentRequest(token, this.requestEpisodeId)) {
          return;
        }
        if (source !== this.baseSrc || !image.complete) return;
        if (image.naturalWidth) this.finishBaseImage(image, token, source);
        else this.failBaseImage(token, source);
      });
    },
    checkEpisodeImage(token, source) {
      this.$nextTick(() => {
        const image = this.$refs.episodeImage;
        if (!image || !this.isCurrentRequest(token, this.requestEpisodeId)) {
          return;
        }
        if (!image.complete) return;
        if (image.naturalWidth) this.finishEpisodeImage(image, token, source);
        else this.failEpisodeImage(token, source);
      });
    },
    onBaseLoad(event) {
      const image = event.currentTarget;
      this.finishBaseImage(
        image,
        Number(image.dataset.coverToken),
        image.dataset.coverSource
      );
    },
    onBaseError(event) {
      const image = event.currentTarget;
      if (
        !this.isCurrentRequest(
          Number(image.dataset.coverToken),
          this.requestEpisodeId
        )
      ) {
        return;
      }
      this.failBaseImage(
        Number(image.dataset.coverToken),
        image.dataset.coverSource
      );
    },
    finishBaseImage(image, token, source) {
      if (!this.isCurrentRequest(token, this.requestEpisodeId)) return;
      if (source !== this.baseSrc || !this.currentPlan) return;
      decodeImage(image).then(decoded => {
        if (!this.isCurrentRequest(token, this.requestEpisodeId)) return;
        if (source !== this.baseSrc || !this.currentPlan) return;
        if (!decoded) {
          this.failBaseImage(token, source);
          return;
        }
        if (this.baseReady) return;
        this.baseReady = true;
        this.revealEpisodeIfReady();
        this.scheduleCoverCachePersistence({
          layer: 'base',
          token,
          episodeId: this.requestEpisodeId,
          url: this.currentPlan.podcastUrl,
          source: this.baseSource,
          image,
        });
      });
    },
    failBaseImage(token, source) {
      if (!this.isCurrentRequest(token, this.requestEpisodeId)) return;
      if (source !== this.baseSrc) return;
      this.baseReady = false;
      this.baseFailed = true;
      this.baseResolved = true;
      this.revealEpisodeIfReady();
    },
    onEpisodeLoad(event) {
      const image = event.currentTarget;
      this.finishEpisodeImage(
        image,
        Number(image.dataset.coverToken),
        image.dataset.coverSource
      );
    },
    onEpisodeError(event) {
      const image = event.currentTarget;
      this.failEpisodeImage(
        Number(image.dataset.coverToken),
        image.dataset.coverSource
      );
    },
    finishEpisodeImage(image, token, source) {
      if (!this.isCurrentRequest(token, this.requestEpisodeId)) return;
      if (source !== this.episodeSrc) return;
      decodeImage(image).then(decoded => {
        if (!this.isCurrentRequest(token, this.requestEpisodeId)) return;
        if (source !== this.episodeSrc) return;
        if (!decoded) {
          this.failEpisodeImage(token, source);
          return;
        }
        if (this.episodeDecoded) return;
        this.episodeDecoded = true;
        this.revealEpisodeIfReady();
        this.scheduleCoverCachePersistence({
          layer: 'episode',
          token,
          episodeId: this.requestEpisodeId,
          url: this.currentPlan && this.currentPlan.episodeUrl,
          source: this.episodeSource,
          image,
        });
      });
    },
    revealEpisodeIfReady() {
      if (!this.episodeDecoded || !this.episodeSrc || this.episodeReady) return;
      if (!this.baseResolved) return;
      if (this.baseSrc && !this.baseReady && !this.baseFailed) return;
      const readyState = getSubscriptionEpisodeCoverReadyState({
        source: this.episodeSource,
        reducedMotion: this.currentPlan && this.currentPlan.reducedMotion,
      });
      this.episodeReady = readyState.visible;
      this.episodeAnimate = readyState.animate;
      this.episodeSettled = readyState.settleImmediately;
    },
    failEpisodeImage(token, source) {
      if (!this.isCurrentRequest(token, this.requestEpisodeId)) return;
      if (source !== this.episodeSrc) return;
      const fallback = getSubscriptionEpisodeCoverFailureState(
        this.currentPlan
      );
      this.episodeSrc = fallback.episodeSrc;
      this.episodeSource = fallback.episodeSource;
      if (!this.baseSrc && fallback.fallbackSrc)
        this.baseSrc = fallback.fallbackSrc;
      this.episodeDecoded = false;
      this.episodeReady = false;
      this.episodeAnimate = false;
      this.episodeSettled = false;
    },
    onEpisodeTransitionEnd(event) {
      if (event.propertyName !== 'opacity' || !this.episodeReady) return;
      const image = event.currentTarget;
      if (
        !this.isCurrentRequest(
          Number(image.dataset.coverToken),
          this.requestEpisodeId
        )
      ) {
        return;
      }
      if (image.dataset.coverSource !== this.episodeSrc) return;
      this.episodeSettled = true;
    },
  },
};
</script>

<style lang="scss" scoped>
.subscription-episode-cover {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--color-secondary-bg);
}

.episode-cover-placeholder,
.episode-cover-image {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}

.episode-cover-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text);
  background: var(--color-secondary-bg);

  .svg-icon {
    width: 36%;
    height: 36%;
    opacity: 0.35;
  }
}

.episode-cover-image {
  object-fit: cover;
}

.episode-cover-base {
  pointer-events: auto;
  visibility: hidden;

  &.is-ready {
    visibility: visible;
  }
}

.episode-cover-overlay {
  z-index: 2;
  opacity: 0;
  pointer-events: none;
  transition: opacity 140ms cubic-bezier(0.22, 1, 0.36, 1);

  &.is-ready {
    opacity: 1;
    pointer-events: auto;
  }

  &.is-instant {
    transition: none;
  }
}

.subscription-episode-cover.is-overlay-settled .episode-cover-base {
  pointer-events: none;
  visibility: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .episode-cover-overlay {
    transition: none;
  }
}
</style>
