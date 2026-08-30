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
//
// Each entry may also carry "include"/"exclude": lists of regexes applied
// to the request path ("/" + remain) as a security filter. When "include"
// is set, the path must match at least one pattern to be processed; when
// "exclude" is set, the path must not match any pattern. Both may be
// combined (include first, then exclude).
package config

import (
	"encoding/json"
	"log"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Config renders urls and reloads when the config file changes.
type Config struct {
	path string

	mu      sync.RWMutex
	data    data
	filters map[string]map[string]*filter
	lastMod time.Time
}

type data struct {
	Tunnel map[string]map[string]entry `json:"tunnel"`
}

type entry struct {
	URL     string   `json:"url"`
	Include []string `json:"include,omitempty"`
	Exclude []string `json:"exclude,omitempty"`
}

// filter holds the compiled include/exclude regexes of one entry.
type filter struct {
	include []*regexp.Regexp
	exclude []*regexp.Regexp
}

// empty reports whether the filter has no patterns at all.
func (f *filter) empty() bool {
	return f == nil || (len(f.include) == 0 && len(f.exclude) == 0)
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
	filters := buildFilters(d)
	c.mu.Lock()
	c.data = d
	c.filters = filters
	c.lastMod = mod
	c.mu.Unlock()
	log.Printf(`[I] %s update config: %s`, now(), c.path)
}

// buildFilters compiles the include/exclude regexes of every entry.
// Invalid patterns are logged and skipped; the rest still take effect.
func buildFilters(d data) map[string]map[string]*filter {
	filters := make(map[string]map[string]*filter, len(d.Tunnel))
	for mode, regions := range d.Tunnel {
		filters[mode] = make(map[string]*filter, len(regions))
		for region, e := range regions {
			f := &filter{}
			for _, p := range e.Include {
				if re, err := regexp.Compile(p); err == nil {
					f.include = append(f.include, re)
				} else {
					log.Printf(`[W] %s config: bad include regexp %q for %s.%s: %v`, now(), p, mode, region, err)
				}
			}
			for _, p := range e.Exclude {
				if re, err := regexp.Compile(p); err == nil {
					f.exclude = append(f.exclude, re)
				} else {
					log.Printf(`[W] %s config: bad exclude regexp %q for %s.%s: %v`, now(), p, mode, region, err)
				}
			}
			filters[mode][region] = f
		}
	}
	return filters
}

// Allowed reports whether uriPath (the request path, e.g. "/api/v1/test")
// may be bridged for mode/region according to the entry's include/exclude
// regex lists. Unknown regions are allowed here; RenderURL reports them.
func (c *Config) Allowed(mode, region, uriPath string) bool {
	c.mu.RLock()
	f := c.filters[mode][region]
	c.mu.RUnlock()
	if f.empty() {
		return true
	}
	if len(f.include) > 0 {
		hit := false
		for _, re := range f.include {
			if re.MatchString(uriPath) {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	for _, re := range f.exclude {
		if re.MatchString(uriPath) {
			return false
		}
	}
	return true
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
