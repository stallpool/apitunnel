package env

import (
	"os"
	"strconv"
	"strings"
)

// Config holds all runtime settings for the pub server.
// Environment variable names match the legacy JS pub.
type Config struct {
	Debug bool
	Host  string
	Port  int
	// CA is the directory holding ca.crt / ca.key; empty means plain HTTP.
	CA      string
	Salt    string
	Token   string
	Entries []string
	// RateLimit caps in-flight bridged requests; 0 means unlimited.
	RateLimit int
}

func Load() Config {
	cfg := Config{
		Debug: os.Getenv("TINY_DEBUG") != "",
		Host:  getEnv("TINY_HOST", "127.0.0.1"),
		Port:  getEnvInt("TINY_PORT", 5001),
		CA:    os.Getenv("TINY_HTTPS_CA_DIR"),
		Salt:  os.Getenv("PUB_SALT"),
		Token: os.Getenv("PUB_TOKEN"),
	}
	if v := os.Getenv("PUB_API"); v != "" {
		cfg.Entries = strings.Split(v, ",")
	} else {
		cfg.Entries = []string{"pub"}
	}
	cfg.RateLimit = getEnvInt("PUB_RATELIMIT", 0)
	return cfg
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getEnvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
