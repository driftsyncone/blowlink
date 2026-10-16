// vacuglide-bridge pretends to be an Intiface (Buttplug) server with one
// device, and drives an Autoblow VacuGlide through the Autoblow cloud API.
//
// The VacuGlide API has no position control, only a target speed (0-100 %),
// so every command is turned into a speed:
//   - Vibrate / Scalar / Rotate: the level is the speed.
//   - Linear (stroke) commands: the stroke rate becomes the speed (-map tempo),
//     or the stroke velocity, as Autoblow's own funscript player does (-map velocity).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const deviceName = "Autoblow VacuGlide"

var (
	addr     = flag.String("addr", "127.0.0.1:12345", "websocket listen address (Intiface default is 12345)")
	tokenArg = flag.String("token", "", "VacuGlide device token (or $VACUGLIDE_TOKEN, or ~/.config/vacuglide-bridge/token)")
	maxSpeed = flag.Int("max", 100, "speed cap in percent (strokes faster than this are clamped)")
	minSpeed = flag.Int("min", 5, "lowest non-zero speed in percent (Autoblow's own app starts at 5)")
	mapping  = flag.String("map", "tempo", `how strokes become speed: "tempo" (strokes per minute, depth ignored) or "velocity" (like Autoblow's own funscript player)`)
	spmLow   = flag.Float64("spm-low", 15, `-map tempo: device strokes per minute at 1% speed (VacuGlide 2: 15, VacuGlide 1: 25)`)
	spmHigh  = flag.Float64("spm-high", 225, `-map tempo: device strokes per minute at 100% speed (VacuGlide 2: 225, VacuGlide 1: 200)`)
	interval = flag.Duration("interval", 200*time.Millisecond, "minimum time between API calls")
	idle     = flag.Duration("idle", 1500*time.Millisecond, "stop after this long with no stroke commands")
	dry      = flag.Bool("dry", false, "log speeds instead of calling the API")
	verbose  = flag.Bool("v", false, "log every Buttplug message")
)

// ---------- speed state ----------

type motor struct {
	mu       sync.Mutex
	want     int       // desired speed 0-100
	lastPos  float64   // last linear target position
	lastMove time.Time // when the last moving LinearCmd arrived
	rate     float64   // smoothed speed (or stroke rate, -map tempo) from linear commands
	linear   bool      // current speed comes from linear commands
	deadline time.Time // linear mode: drop to 0 after this
	wake     chan struct{}
}

func newMotor() *motor { return &motor{wake: make(chan struct{}, 1)} }

// set stores a speed in percent, clamped to -min..-max (0 stays 0).
func (m *motor) set(pct float64, linear bool, hold time.Duration) {
	v := 0
	if pct > 0 {
		v = int(math.Round(pct))
		v = max(v, *minSpeed, 1)
		v = min(v, *maxSpeed)
	}
	m.mu.Lock()
	m.want, m.linear = v, linear
	if linear {
		m.deadline = time.Now().Add(hold)
	} else {
		m.rate, m.lastMove = 0, time.Time{}
	}
	m.mu.Unlock()
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// scalar handles vibrate-style levels, scaled to -max. Games that drive strokers
// often send vibrate pulses alongside LinearCmd; while strokes are active those are ignored.
func (m *motor) scalar(level float64) {
	m.mu.Lock()
	stroking := m.linear && time.Now().Before(m.deadline)
	m.mu.Unlock()
	if stroking {
		return
	}
	m.set(clamp01(level)*float64(*maxSpeed), false, 0)
}

// stroke turns a LinearCmd into a device speed: from the stroke rate (default)
// or, with -map velocity, from the move's velocity. A full stroke is down and
// back up, i.e. two moves. Example: Cock Hero sends 0 then 1, each lasting half a
// beat, so 120 BPM = 120 strokes/min (tempo) = 400 units/s = 67 % (velocity).
func (m *motor) stroke(pos float64, durMs float64) {
	pos = clamp01(pos)
	m.mu.Lock()
	dist := math.Abs(pos - m.lastPos)
	m.lastPos = pos
	if dist < 0.05 { // hold or tiny move: keep the current rate going
		m.linear = true // still blocks vibrate pulses, e.g. on the very first stroke
		m.deadline = time.Now().Add(time.Duration(durMs)*time.Millisecond + *idle)
		m.mu.Unlock()
		return
	}
	// Time the move really takes: the stated duration, or the gap since the last
	// move if longer (a quick move followed by a hold until the next beat).
	secs := math.Max(durMs, 50) / 1000
	now := time.Now()
	gap := now.Sub(m.lastMove).Seconds()
	m.lastMove = now
	if !m.linear || now.After(m.deadline) || gap > 10 {
		// First move of a run: the real pace is unknown until the next move
		// arrives, so just start tracking (avoids a speed spike on quick moves).
		m.linear, m.rate = true, 0
		m.deadline = now.Add(time.Duration(secs*float64(time.Second)) + *idle)
		m.mu.Unlock()
		return
	}
	if gap > secs {
		secs = gap
	}
	var rate float64
	if *mapping == "tempo" {
		// Count strokes, not depth: a shallow stroke on the beat is still a stroke.
		rate = 60 / secs / 2
	} else {
		// Same curve as Autoblow's own funscript player (measured on a VacuGlide 2):
		// speed % = funscript units per second ÷ 6, so 600 units/s and up is 100 %.
		// Depth counts: a half-depth stroke in the same time runs at half speed.
		rate = dist * 100 / secs / 6
	}
	if m.rate > 0 { // light smoothing so speed doesn't jump every stroke
		rate = 0.6*rate + 0.4*m.rate
	}
	m.rate = rate
	m.mu.Unlock()

	pct := rate
	if *mapping == "tempo" {
		pct = 1 + (rate-*spmLow)/(*spmHigh-*spmLow)*99
	}
	m.set(math.Max(pct, 1), true, time.Duration(secs*float64(time.Second))+*idle)
}

func (m *motor) stop() { m.set(0, false, 0) }

// current returns the speed to send now, applying the linear idle timeout.
func (m *motor) current() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.linear && m.want > 0 && time.Now().After(m.deadline) {
		m.want = 0
	}
	return m.want
}

func abs(n int) int { return max(n, -n) }

func clamp01(f float64) float64 { return math.Max(0, math.Min(1, f)) }

// ---------- Autoblow API ----------

type api struct {
	token string
	host  string
	hc    *http.Client
}

func (a *api) do(method, url string, body any) (map[string]any, int, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, url, rd)
	req.Header.Set("x-device-token", a.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.hc.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode >= 300 {
		return out, resp.StatusCode, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return out, resp.StatusCode, nil
}

func (a *api) discover() error {
	d, _, err := a.do("GET", "https://latency.autoblowapi.com/vacuglide/connected", nil)
	if err != nil {
		return err
	}
	if c, _ := d["connected"].(bool); !c {
		return errors.New("device offline (hold the mode button 2.5 s to put it online)")
	}
	if t, _ := d["deviceType"].(string); t != "" && t != "vacuglide" {
		return fmt.Errorf("token is for a %s, not a vacuglide", t)
	}
	c, _ := d["cluster"].(string)
	c = strings.TrimPrefix(strings.TrimPrefix(c, "https://"), "http://")
	if !strings.Contains(c, ".") {
		c += ".autoblowapi.com"
	}
	a.host = "https://" + c
	return nil
}

func (a *api) setSpeed(v int) error {
	if v == 0 {
		_, _, err := a.do("PUT", a.host+"/vacuglide/target-speed/stop", nil)
		return err
	}
	_, code, err := a.do("PUT", a.host+"/vacuglide/target-speed", map[string]int{"targetSpeed": v})
	if code == 429 {
		time.Sleep(time.Second)
	}
	return err
}

// sender pushes the motor's speed to the device: only on change, at most once per interval.
func sender(ctx context.Context, m *motor, a *api) {
	sent := -1
	tick := time.NewTicker(*interval)
	defer tick.Stop()
	var lastErr time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-m.wake:
		}
		if a != nil && a.host == "" {
			if err := a.discover(); err != nil {
				if time.Since(lastErr) > 10*time.Second {
					log.Printf("VacuGlide not reachable: %v (retrying)", err)
					lastErr = time.Now()
				}
				time.Sleep(2 * time.Second)
				continue
			}
			log.Printf("VacuGlide connected via %s", a.host)
		}
		v := m.current()
		// Skip small wobbles (stroke timing jitters a little) to save API calls.
		if v == sent || (v > 0 && sent > 0 && abs(v-sent) < 5) {
			continue
		}
		if a == nil {
			log.Printf("speed %d%%", v)
		} else if err := a.setSpeed(v); err != nil {
			if time.Since(lastErr) > 5*time.Second {
				log.Printf("set speed %d: %v", v, err)
				lastErr = time.Now()
			}
			if strings.Contains(err.Error(), "HTTP 502") {
				a.host = "" // device dropped off; rediscover
			}
			continue
		}
		sent = v
		// wait out the interval before the next call
		select {
		case <-ctx.Done():
			return
		case <-time.After(*interval):
		}
	}
}

// ---------- Buttplug server ----------

type msg = map[string]any

func deviceMessages(ver int) any {
	switch {
	case ver >= 3:
		return msg{
			"ScalarCmd":     []msg{{"FeatureDescriptor": "Speed", "StepCount": 100, "ActuatorType": "Vibrate"}},
			"LinearCmd":     []msg{{"FeatureDescriptor": "Stroke", "StepCount": 100, "ActuatorType": "Position"}},
			"StopDeviceCmd": msg{},
		}
	case ver == 2:
		return msg{
			"VibrateCmd":    msg{"FeatureCount": 1, "StepCount": []int{100}},
			"LinearCmd":     msg{"FeatureCount": 1, "StepCount": []int{100}},
			"StopDeviceCmd": msg{},
		}
	case ver == 1:
		return msg{
			"VibrateCmd":            msg{"FeatureCount": 1},
			"LinearCmd":             msg{"FeatureCount": 1},
			"SingleMotorVibrateCmd": msg{},
			"StopDeviceCmd":         msg{},
		}
	default:
		return []string{"SingleMotorVibrateCmd", "StopDeviceCmd"}
	}
}

func deviceInfo(ver int) msg {
	return msg{"DeviceName": deviceName, "DeviceIndex": 0, "DeviceMessages": deviceMessages(ver)}
}

type session struct {
	conn      *websocket.Conn
	m         *motor
	ver       int
	wmu       sync.Mutex
	announced bool // DeviceAdded already sent; real Intiface doesn't re-announce on rescans
}

func (s *session) send(ctx context.Context, msgs ...msg) {
	b, _ := json.Marshal(msgs)
	if *verbose {
		log.Printf("-> %s", b)
	}
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_ = s.conn.Write(ctx, websocket.MessageText, b)
}

func reply(typ string, id any, body msg) msg {
	if body == nil {
		body = msg{}
	}
	body["Id"] = id
	return msg{typ: body}
}

func errMsg(id any, code int, text string) msg {
	return reply("Error", id, msg{"ErrorMessage": text, "ErrorCode": code})
}

func num(v any) float64 { f, _ := v.(float64); return f }

func (s *session) handle(ctx context.Context, typ string, b msg) msg {
	id := b["Id"]
	ok := reply("Ok", id, nil)
	if idx, has := b["DeviceIndex"]; has && num(idx) != 0 {
		return errMsg(id, 4, "unknown device index")
	}
	switch typ {
	case "RequestServerInfo":
		s.ver = 3
		if v, has := b["MessageVersion"]; has && int(num(v)) < 3 {
			s.ver = int(num(v))
		}
		log.Printf("client %q connected (protocol v%d)", b["ClientName"], s.ver)
		return reply("ServerInfo", id, msg{"ServerName": "vacuglide-bridge", "MessageVersion": s.ver, "MaxPingTime": 0})
	case "Ping", "StopScanning":
		return ok
	case "StartScanning":
		events := []msg{reply("ScanningFinished", 0, nil)}
		if !s.announced {
			s.announced = true
			events = append([]msg{reply("DeviceAdded", 0, deviceInfo(s.ver))}, events...)
		}
		go func() {
			time.Sleep(50 * time.Millisecond)
			s.send(ctx, events...)
		}()
		return ok
	case "RequestDeviceList":
		s.announced = true
		return reply("DeviceList", id, msg{"Devices": []msg{deviceInfo(s.ver)}})
	case "StopDeviceCmd", "StopAllDevices":
		s.m.stop()
		return ok
	case "SingleMotorVibrateCmd":
		s.m.scalar(num(b["Speed"]))
		return ok
	case "VibrateCmd", "RotateCmd", "ScalarCmd":
		key, field := "Speeds", "Speed"
		if typ == "RotateCmd" {
			key = "Rotations"
		} else if typ == "ScalarCmd" {
			key, field = "Scalars", "Scalar"
		}
		if list, _ := b[key].([]any); len(list) > 0 {
			if e, _ := list[0].(map[string]any); e != nil {
				s.m.scalar(num(e[field]))
			}
		}
		return ok
	case "LinearCmd":
		if list, _ := b["Vectors"].([]any); len(list) > 0 {
			if e, _ := list[0].(map[string]any); e != nil {
				s.m.stroke(num(e["Position"]), num(e["Duration"]))
			}
		}
		return ok
	case "FleshlightLaunchFW12Cmd": // v0 stroker message: Position/Speed 0-99
		s.m.scalar(num(b["Speed"]) / 99)
		return ok
	}
	return errMsg(id, 3, "unsupported message "+typ)
}

func serve(m *motor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		conn.SetReadLimit(1 << 20)
		s := &session{conn: conn, m: m, ver: 3}
		ctx := r.Context()
		defer func() {
			m.stop()
			conn.Close(websocket.StatusNormalClosure, "")
			log.Printf("client disconnected, device stopped")
		}()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if *verbose {
				log.Printf("<- %s", data)
			}
			var in []map[string]msg
			if err := json.Unmarshal(data, &in); err != nil {
				s.send(ctx, errMsg(0, 3, "bad JSON: "+err.Error()))
				continue
			}
			var out []msg
			for _, item := range in {
				for typ, body := range item {
					out = append(out, s.handle(ctx, typ, body))
				}
			}
			s.send(ctx, out...)
		}
	}
}

func loadToken() string {
	if *tokenArg != "" {
		return *tokenArg
	}
	if t := os.Getenv("VACUGLIDE_TOKEN"); t != "" {
		return t
	}
	home, _ := os.UserHomeDir()
	b, _ := os.ReadFile(filepath.Join(home, ".config", "vacuglide-bridge", "token"))
	return strings.TrimSpace(string(b))
}

func main() {
	flag.Parse()
	log.SetFlags(log.Ltime)
	if *mapping != "velocity" && *mapping != "tempo" {
		log.Fatalf(`-map must be "velocity" or "tempo", not %q`, *mapping)
	}

	var a *api
	if !*dry {
		t := loadToken()
		if t == "" {
			log.Fatal("no device token: use -token, $VACUGLIDE_TOKEN, or ~/.config/vacuglide-bridge/token")
		}
		a = &api{token: t, hc: &http.Client{Timeout: 5 * time.Second}}
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	m := newMotor()
	go sender(ctx, m, a)

	srv := &http.Server{Addr: *addr, Handler: serve(m)}
	go func() {
		log.Printf("Intiface stand-in listening on ws://%s", *addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	_ = srv.Close()
	if a != nil && a.host != "" {
		_ = a.setSpeed(0)
	}
	log.Print("stopped")
}
