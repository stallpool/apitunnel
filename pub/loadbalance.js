class NoLoadBalance {
   constructor(chainConn) { this.conn = chainConn || []; }
   hasEmptySlot() { return this.conn.length === 0; }
   setSlotN(n) {}
   hasConn() { return this.conn.length > 0; }
   countConn() { return this.conn.length; }
   addConn(conn) { this.conn.push(conn); }
   delConn(conn) {
      const i = this.conn.indexOf(conn);
      if (i >= 0) this.conn.splice(i, 1);
   }
   getOne(id) { return id ? this.conn[0] : null; }
   cancelOne(id) {}
}

class RoundRobinLoadBalance {
   constructor(chainConn) { this.conn = chainConn || []; this.n = 1; this.index = 0; }
   hasEmptySlot() { return this.conn.length < this.n; }
   setSlotN(n) { this.n = n; }
   hasConn() { return this.conn.length > 0; }
   countConn() { return this.conn.length; }
   addConn(conn) { this.conn.push(conn); }
   delConn(conn) {
      const i = this.conn.indexOf(conn);
      if (i >= 0) this.conn.splice(i, 1);
      if (i >= this.index) this.index --;
      if (this.index < 0) this.index = 0;
   }
   getOne(id) {
      if (!id) return null;
      const n = this.countConn();
      if (!n) return null;
      const conn = this.conn[this.index];
console.log('roundrobin', id, this.index);
      this.index = (this.index + 1) % n;
      return conn;
   }
   cancelOne(id) {}
}

const cid_max = 1000000;
class IdBindLoadBalance {
   constructor(chainConn) { this.conn = chainConn || []; this.map = {}; this.ids = {}; this.n = 1; this.cid = -1; }
   hasEmptySlot() { return this.conn.length < this.n; }
   setSlotN(n) { this.n = n; }
   hasConn() { return this.conn.length > 0; }
   countConn() { return this.conn.length; }
   _assignCid(conn) {
      if (!conn) return;
      let cid = (this.cid + 1) % cid_max;
      while (this.map[cid]) cid = (cid + 1) % cid_max;
      if (!conn._meta_) conn._meta_ = {};
      conn._meta_.cid = cid;
      this.map[cid] = conn;
      this.cid = cid;
console.log('idbind.assign', this.conn.length, conn._meta_.cid);
   }
   addConn(conn) {
      this.conn.push(conn);
      this._assignCid(conn);
   }
   delConn(conn) {
      const i = this.conn.indexOf(conn);
      if (i >= 0) this.conn.splice(i, 1);
      const cid = conn._meta_?.cid;
      if (isNaN(cid)) return;
      delete conn._meta_.cid;
      delete this.map[cid];
      Object.keys(this.ids).forEach(id => {
         if (this.ids[id] !== cid) return;
         delete this.ids[id];
      });
   }
   getOne(id) {
console.log(1, id);
      if (!id) return null;
      const n = this.countConn();
console.log(2, n);
      if (!n) return null;
console.log('idbind', id, this.ids[id]);
      if (this.ids[id]) {
         return this.map[this.ids[id]];
      }
      const index = id % n;
      const conn = this.conn[index];
      if (!conn._meta_ || isNaN(conn._meta_?.cid)) this._assignCid(conn);
console.log('idbind.to', id, conn._meta_.cid);
      this.ids[id] = conn._meta_?.cid;
      return conn;
   }
   cancelOne(id) { delete this.ids[id]; }
}

module.exports = {
   NoLoadBalance,
   RoundRobinLoadBalance,
   IdBindLoadBalance,
};
