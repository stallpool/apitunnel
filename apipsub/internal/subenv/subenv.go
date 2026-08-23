// Package subenv loads the sub runtime settings from environment variables.
// The variable names match the legacy JS sub.
package subenv

import (
	"os"
	"strconv"
)

// Config holds all runtime settings for the sub.
type Config struct {
	Debug bool
	// PubURL is the pub subscriber endpoint. The legacy JS used a ws:// URL;
	// the sub normalizes it to http(s)://. The path should be /sub/<entry>.
	PubURL string
	// Token is the raw pub token; empty disables subscriber auth.
	Token string
	// ConfigPath is the config.json holding url templates; empty disables it.
	ConfigPath string
	// LB / LBN select the entry load balancer; the first sub of an entry
	// decides, so these are honored only by that first subscriber.
	LB  string
	LBN int
}

// Load reads the sub settings from the environment.
func Load() Config {
	return Config{
		Debug:      os.Getenv("TINY_DEBUG") != "",
		PubURL:     os.Getenv("PUB_URL"),
		Token:      os.Getenv("PUB_TOKEN"),
		ConfigPath: os.Getenv("SUB_CONFIG"),
		LB:         os.Getenv("SUB_LB"),
		LBN:        getEnvInt("SUB_LB_N", 1),
	}
}

func getEnvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
