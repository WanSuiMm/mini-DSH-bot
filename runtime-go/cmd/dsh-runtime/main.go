package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	dshr "github.com/WanSuiMm/micro-dsh-runtime/internal/runtime"
)

func main() {
	path := os.Getenv("DSH_RUNTIME_CONFIG")
	if path == "" {
		log.Fatal("DSH_RUNTIME_CONFIG must point to the private runtime configuration file")
	}
	cfg, err := dshr.LoadConfig(path)
	if err != nil {
		log.Fatal("runtime configuration invalid")
	}
	service, err := dshr.NewService(cfg)
	if err != nil {
		log.Fatal("runtime service initialization failed")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	service.Start(ctx)
	server := &http.Server{Addr: cfg.Listen, Handler: service.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 0, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ListenAndServe() }()
	select {
	case err = <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatal("runtime HTTP listener failed")
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		if err = service.Close(shutdownCtx); err != nil {
			log.Print("runtime shutdown timed out")
		}
	}
}
