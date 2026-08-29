// ============================================================
// Juwita Offline DB — IndexedDB helper (native, tanpa library)
// Digunakan POS offline: simpan transaksi ke antrean lokal,
// lalu disinkronkan ke Supabase via RPC sync_offline_order.
// ============================================================
(function (window) {
  "use strict";

  const DB_NAME = "JuwitaOfflineDB";
  const DB_VERSION = 2;
  const STORE_ORDERS = "orders_queue";
  const STORE_META = "meta";

  let _dbPromise = null;

  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_ORDERS)) {
          const store = db.createObjectStore(STORE_ORDERS, { keyPath: "local_transaction_id" });
          store.createIndex("created_at", "created_at", { unique: false });
          store.createIndex("status", "status", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function () { reject(req.error || new Error("IndexedDB open failed")); };
    });
    return _dbPromise;
  }

  // Inisialisasi DB + pastikan meta tersedia.
  function init() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_META, "readwrite");
        const store = tx.objectStore(STORE_META);
        const getReq = store.get("initialized");
        getReq.onsuccess = function () {
          if (!getReq.result) {
            store.put({ key: "initialized", value: true, created_at: new Date().toISOString() });
          }
        };
        getReq.onerror = function () { reject(getReq.error || new Error("meta init failed")); };
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error || new Error("meta tx failed")); };
        tx.onabort = function () { reject(tx.error || new Error("meta tx aborted")); };
      });
    });
  }

  function withStore(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_ORDERS, mode);
        const store = tx.objectStore(STORE_ORDERS);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error || new Error("IndexedDB transaction failed")); };
        tx.onabort = function () { reject(tx.error || new Error("IndexedDB transaction aborted")); };
      });
    });
  }

  // Simpan 1 transaksi offline. Menolak jika gagal (jangan pura-pura sukses).
  function saveOrder(order) {
    return withStore("readwrite", function (store) {
      store.put(order);
    });
  }

  // Ambil semua transaksi (urut created_at), status optional filter.
  function getAllOrders(status) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_ORDERS, "readonly");
        const store = tx.objectStore(STORE_ORDERS);
        const req = status
          ? store.index("status").getAll(status)
          : store.getAll();
        req.onsuccess = function () {
          let rows = req.result || [];
          rows.sort(function (a, b) {
            return String(a.created_at || "").localeCompare(String(b.created_at || ""));
          });
          resolve(rows);
        };
        req.onerror = function () { reject(req.error || new Error("read failed")); };
      });
    });
  }

  // Update status/error transaksi tertentu (pakai idempotency_key yang tersimpan).
  function updateOrderStatus(localTransactionId, status, errorMessage) {
    return withStore("readwrite", function (store) {
      const getReq = store.get(localTransactionId);
      getReq.onsuccess = function () {
        const rec = getReq.result;
        if (rec) {
          rec.status = status;
          rec.error_message = errorMessage || null;
          store.put(rec);
        }
      };
    });
  }

  // Hapus transaksi dari queue (setelah berhasil sync).
  function deleteOrder(localTransactionId) {
    return withStore("readwrite", function (store) {
      store.delete(localTransactionId);
    });
  }

  // Jumlah transaksi yang masih MENUNGGU sinkronisasi (hanya status pending).
  function countPending() {
    return getAllOrders("pending").then(function (rows) { return rows.length; });
  }

  // Jumlah transaksi yang GAGAL dan perlu tindakan (status failed).
  function countFailed() {
    return getAllOrders("failed").then(function (rows) { return rows.length; });
  }

  // ============================================================
  // META store
  // ============================================================
  function setMeta(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_META, "readwrite");
        const store = tx.objectStore(STORE_META);
        store.put({ key: key, value: value, updated_at: new Date().toISOString() });
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error || new Error("meta write failed")); };
        tx.onabort = function () { reject(tx.error || new Error("meta write aborted")); };
      });
    });
  }

  function getMeta(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE_META, "readonly");
        const store = tx.objectStore(STORE_META);
        const req = store.get(key);
        req.onsuccess = function () {
          resolve(req.result ? req.result.value : null);
        };
        req.onerror = function () { reject(req.error || new Error("meta read failed")); };
      });
    });
  }

  // TODO(offline): IndexedDB dapat hilang jika browser storage dibersihkan.
  // Export/import queue belum dibuat (out of scope) — indikator UI sudah memadai.

  window.JuwitaOfflineDB = {
    init: init,
    saveOrder: saveOrder,
    getAllOrders: getAllOrders,
    updateOrderStatus: updateOrderStatus,
    deleteOrder: deleteOrder,
    countPending: countPending,
    countFailed: countFailed,
    setMeta: setMeta,
    getMeta: getMeta
  };
})(window);
