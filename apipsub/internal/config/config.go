// Package config renders backend urls from a watched config.json.
//
// The file has the shape (from the legacy JS sub/config.js):
//
//	{
//	  "tunnel": {
//	    "http": { "<region>": { "url": "http://&<site>.&<region>.local/&<remain>" } }
//	  }
//	}
//
// A request to pub's /<entry>/<region>/<site>/<remain> is rendered to the
// backend url by expanding &<region>, &<site> and &<remain>.
package config

import (
	"encoding/json"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// Config renders urls and reloads when the config file changes.
type Config struct {
	path string

	mu      sync.RWMutex
	data    data
	lastMod time.Time
}

type data struct {
	Tunnel map[string]map[string]entry `json:"tunnel"`
}

type entry struct {
	URL string `json:"url"`
}

// New loads the config file (if path is set) and returns a *Config.
func New(path string) *Config {
	c := &Config{path: path}
	if path != "" {
		c.reload()
	}
	return c
}

// StartWatch reloads the file in the background whenever its mtime changes.
func (c *Config) StartWatch() {
	if c.path == "" {
		return
	}
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for range t.C {
			c.reload()
		}
	}()
}

func (c *Config) reload() {
	fi, err := os.Stat(c.path)
	if err != nil {
		return
	}
	mod := fi.ModTime()
	c.mu.RLock()
	unchanged := mod.Equal(c.lastMod)
	c.mu.RUnlock()
	if unchanged {
		return
	}
	buf, err := os.ReadFile(c.path)
	if err != nil {
		return
	}
	var d data
	if json.Unmarshal(buf, &d) != nil {
		return
	}
	c.mu.Lock()
	c.data = d
	c.lastMod = mod
	c.mu.Unlock()
	log.Printf(`[I] %s update config: %s`, now(), c.path)
}

// RenderURL expands the url template for mode/region, replacing &<region>,
// &<site> and &<remain>; it returns "" when no such region is configured.
func (c *Config) RenderURL(mode, region, site, remain string) string {
	c.mu.RLock()
	e := c.data.Tunnel[mode][region]
	c.mu.RUnlock()
	if e.URL == "" {
		return ""
	}
	var b strings.Builder
	pieces := strings.Split(e.URL, "&<")
	for i, z := range pieces {
		if i == 0 {
			b.WriteString(z)
			continue
		}
		idx := strings.Index(z, ">")
		if idx < 0 {
			continue
		}
		switch z[:idx] {
		case "region":
			b.WriteString(region)
		case "site":
			b.WriteString(site)
		case "remain":
			b.WriteString(remain)
		}
		b.WriteString(z[idx+1:])
	}
	return b.String()
}

func now() string {
	return time.Now().UTC().Format(time.RFC3339)
}
