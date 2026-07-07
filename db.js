/* IndexedDB ラッパー（stores: questions, attempts） */

const DB = (() => {
  const NAME = "ic-exam";
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("questions")) {
          db.createObjectStore("questions", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("attempts")) {
          const s = db.createObjectStore("attempts", { keyPath: "attempt_id", autoIncrement: true });
          s.createIndex("question_id", "question_id");
          s.createIndex("timestamp", "timestamp");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  function getAll(store) {
    return open().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  return {
    getAllQuestions: () => getAll("questions"),
    getAllAttempts: () => getAll("attempts"),

    /** id 単位で upsert。件数を返す */
    upsertQuestions(questions) {
      return tx("questions", "readwrite", s => {
        for (const q of questions) s.put(q);
      }).then(() => questions.length);
    },

    addAttempt(attempt) {
      return tx("attempts", "readwrite", s => { s.add(attempt); });
    },

    restoreAttempts(attempts) {
      return tx("attempts", "readwrite", s => {
        for (const a of attempts) {
          const { attempt_id, ...rest } = a;
          s.add(rest);
        }
      }).then(() => attempts.length);
    },

    clearAttempts: () => tx("attempts", "readwrite", s => { s.clear(); }),
    clearAll() {
      return tx("questions", "readwrite", s => { s.clear(); })
        .then(() => tx("attempts", "readwrite", s => { s.clear(); }));
    },
  };
})();
