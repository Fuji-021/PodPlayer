// A favorite toggle is a read-modify-write operation. Serialize only the
// same episode so a rapid double click remains two deterministic toggles
// instead of two concurrent reads that both decide to add the item.
export function createFavoriteOperationQueue() {
  const chains = new Map();

  function run(episodeId, operation) {
    const previous = chains.get(episodeId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => operation());

    chains.set(episodeId, current);
    const release = () => {
      if (chains.get(episodeId) === current) chains.delete(episodeId);
    };
    current.then(release, release);
    return current;
  }

  return { run };
}

export const podcastFavoriteOperationQueue = createFavoriteOperationQueue();
