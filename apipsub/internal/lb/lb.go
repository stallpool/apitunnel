package lb

// Conn is a registered subscriber connection.
type Conn interface {
	SendJSON(v any) bool
	Cid() int
	SetCid(c int)
}

// LoadBalance picks subscriber connections for bridged requests.
type LoadBalance interface {
	HasEmptySlot() bool
	SetSlotN(n int)
	HasConn() bool
	CountConn() int
	AddConn(c Conn)
	DelConn(c Conn)
	GetOne(id int) Conn
	CancelOne(id int)
}

// Build creates the load balancer selected by name; empty or unknown names
// give NoLoadBalance. slotN is only applied to named balancers.
func Build(name string, slotN int) LoadBalance {
	var l LoadBalance
	switch name {
	case "roundrobin":
		l = NewRoundLoadBalance()
	case "idbind":
		l = NewIdBindLoadBalance()
	}
	if l != nil && slotN > 0 {
		l.SetSlotN(slotN)
	}
	if l == nil {
		l = NewNoLoadBalance()
	}
	return l
}

func remove(cs []Conn, c Conn) []Conn {
	for i, x := range cs {
		if x == c {
			return append(cs[:i], cs[i+1:]...)
		}
	}
	return cs
}

// NoLoadBalance allows a single subscriber; every request goes to it.
type NoLoadBalance struct {
	Conn []Conn
}

func NewNoLoadBalance() *NoLoadBalance { return &NoLoadBalance{} }

func (l *NoLoadBalance) HasEmptySlot() bool { return len(l.Conn) == 0 }
func (l *NoLoadBalance) SetSlotN(int)       {}
func (l *NoLoadBalance) HasConn() bool      { return len(l.Conn) > 0 }
func (l *NoLoadBalance) CountConn() int     { return len(l.Conn) }
func (l *NoLoadBalance) AddConn(c Conn)     { l.Conn = append(l.Conn, c) }
func (l *NoLoadBalance) DelConn(c Conn)     { l.Conn = remove(l.Conn, c) }

func (l *NoLoadBalance) GetOne(id int) Conn {
	if id == 0 || len(l.Conn) == 0 {
		return nil
	}
	return l.Conn[0]
}

func (l *NoLoadBalance) CancelOne(int) {}

// RoundLoadBalance distributes one request at a time across subscribers.
type RoundLoadBalance struct {
	Conn  []Conn
	SlotN int
	index int
}

func NewRoundLoadBalance() *RoundLoadBalance { return &RoundLoadBalance{SlotN: 1} }

func (l *RoundLoadBalance) HasEmptySlot() bool { return len(l.Conn) < l.SlotN }
func (l *RoundLoadBalance) SetSlotN(n int)     { l.SlotN = n }
func (l *RoundLoadBalance) HasConn() bool      { return len(l.Conn) > 0 }
func (l *RoundLoadBalance) CountConn() int     { return len(l.Conn) }
func (l *RoundLoadBalance) AddConn(c Conn)     { l.Conn = append(l.Conn, c) }

func (l *RoundLoadBalance) DelConn(c Conn) {
	for i, x := range l.Conn {
		if x != c {
			continue
		}
		l.Conn = append(l.Conn[:i], l.Conn[i+1:]...)
		if i >= l.index {
			l.index--
		}
		if l.index < 0 {
			l.index = 0
		}
		if l.index >= len(l.Conn) {
			l.index = 0
		}
		return
	}
}

func (l *RoundLoadBalance) GetOne(id int) Conn {
	if id == 0 || len(l.Conn) == 0 {
		return nil
	}
	c := l.Conn[l.index]
	l.index = (l.index + 1) % len(l.Conn)
	return c
}

func (l *RoundLoadBalance) CancelOne(int) {}

const cidMax = 1000000

// IdBindLoadBalance binds a stable request id to one subscriber, so that
// a client session always lands on the same connection.
type IdBindLoadBalance struct {
	Conn  []Conn
	SlotN int
	cids  map[int]Conn // cid -> conn
	ids   map[int]int  // request id -> cid
	cid   int
}

func NewIdBindLoadBalance() *IdBindLoadBalance {
	return &IdBindLoadBalance{
		SlotN: 1,
		cids:  map[int]Conn{},
		ids:   map[int]int{},
		cid:   -1,
	}
}

func (l *IdBindLoadBalance) HasEmptySlot() bool { return len(l.Conn) < l.SlotN }
func (l *IdBindLoadBalance) SetSlotN(n int)     { l.SlotN = n }
func (l *IdBindLoadBalance) HasConn() bool      { return len(l.Conn) > 0 }
func (l *IdBindLoadBalance) CountConn() int     { return len(l.Conn) }

func (l *IdBindLoadBalance) AddConn(c Conn) {
	l.Conn = append(l.Conn, c)
	l.assignCid(c)
}

func (l *IdBindLoadBalance) DelConn(c Conn) {
	l.Conn = remove(l.Conn, c)
	if c.Cid() < 0 {
		return
	}
	cid := c.Cid()
	c.SetCid(-1)
	delete(l.cids, cid)
	for id, x := range l.ids {
		if x == cid {
			delete(l.ids, id)
		}
	}
}

func (l *IdBindLoadBalance) GetOne(id int) Conn {
	if id == 0 {
		return nil
	}
	n := len(l.Conn)
	if n == 0 {
		return nil
	}
	if cid, ok := l.ids[id]; ok {
		return l.cids[cid]
	}
	c := l.Conn[id%n]
	if c.Cid() < 0 {
		l.assignCid(c)
	}
	l.ids[id] = c.Cid()
	return c
}

func (l *IdBindLoadBalance) CancelOne(id int) { delete(l.ids, id) }

func (l *IdBindLoadBalance) assignCid(c Conn) {
	cid := (l.cid + 1) % cidMax
	for l.cids[cid] != nil {
		cid = (cid + 1) % cidMax
	}
	c.SetCid(cid)
	l.cids[cid] = c
	l.cid = cid
}
