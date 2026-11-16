/* main.c — an OP Console client on an ESP32 with a 240 x 240 ST7789 display and 9 buttons.
 *
 * NOT BUILT OR RUN where this was written: there was no ESP-IDF and no board. It is written
 * against ESP-IDF 5 and its esp_websocket_client component. `make esp32-check` proves only
 * that it is valid C against stand-in headers. The part that does the console's work
 * (ppu.c, raster.c) is the same code `make hardware` builds and checks on a desktop.
 *
 *   idf.py set-target esp32s3 && idf.py build flash monitor       (in hardware/esp32)
 *
 * It needs about 130 KB of free heap for the frame, so use a board with PSRAM.
 * What it does: join Wi-Fi, get a session cookie, open the match socket, apply every
 * packet to the PPU, draw the OP buffer about 30 times a second at the server's tick,
 * and send the input byte when a button changes.
 */
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_websocket_client.h"
#include "nvs_flash.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_ops.h"
#include "raster.h"
#include "wire.h"

/* ---- set these for your network, your console and your board ---------- */
#define WIFI_SSID   "your-wifi"
#define WIFI_PASS   "your-password"
#define HOST        "op-console.example.workers.dev"   /* where the Worker is deployed */
#define CART        "pong"
#define ROOM        "ROOM1"

#define PIN_LCD_CLK  12
#define PIN_LCD_MOSI 11
#define PIN_LCD_CS   10
#define PIN_LCD_DC    9
#define PIN_LCD_RST  14
/* buttons to ground, pulled up: up, right, down, left, A, B, and the three cartridge buttons */
static const gpio_num_t PIN_BTN[9] = { 1, 2, 3, 4, 5, 6, 7, 8, 15 };

#define SIDE 240

/* the PPU (ppu/ppu.c) */
u8 *ppu_rx(void); u32 ppu_apply(u32 len); u8 *ppu_view(u32 tick); u32 ppu_frame(void);
u8 *ppu_strs(void); u8 *ppu_pal(void); u32 ppu_tick(void);

static const char *TAG = "op";
static EventGroupHandle_t net_up;
static SemaphoreHandle_t ppu_lock;
static esp_websocket_client_handle_t ws;
static esp_lcd_panel_handle_t panel;
static u16 *frame;
static char cookie[160];
static u8 packet[WIRE_MAX_PACKET];
static u32 beat_frame;               /* the server tick of the last tick packet ... */
static int64_t beat_us;              /* ... and when it arrived */

/* ---- Wi-Fi -------------------------------------------------------------- */
static void on_net(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg; (void)data;
  if (base == WIFI_EVENT && (id == WIFI_EVENT_STA_START || id == WIFI_EVENT_STA_DISCONNECTED)) esp_wifi_connect();
  else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(net_up, 1);
}
static void wifi_start(void) {
  net_up = xEventGroupCreate();
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_net, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_net, NULL));
  wifi_config_t cfg = { .sta = { .ssid = WIFI_SSID, .password = WIFI_PASS } };
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
  ESP_ERROR_CHECK(esp_wifi_start());
  xEventGroupWaitBits(net_up, 1, pdFALSE, pdTRUE, portMAX_DELAY);
}

/* ---- the account: POST /api/session answers with the session cookie ---- */
static esp_err_t on_http(esp_http_client_event_t *e) {
  if (e->event_id == HTTP_EVENT_ON_HEADER && strcasecmp(e->header_key, "Set-Cookie") == 0) {
    size_t n = strcspn(e->header_value, ";");                 /* keep "name=value" only */
    if (n < sizeof cookie) { memcpy(cookie, e->header_value, n); cookie[n] = 0; }
  }
  return ESP_OK;
}
static void session(void) {
  esp_http_client_config_t cfg = { .url = "https://" HOST "/api/session", .method = HTTP_METHOD_POST,
                                   .event_handler = on_http, .crt_bundle_attach = esp_crt_bundle_attach };
  esp_http_client_handle_t http = esp_http_client_init(&cfg);
  esp_err_t err = esp_http_client_perform(http);
  esp_http_client_cleanup(http);
  if (err != ESP_OK || !cookie[0]) ESP_LOGE(TAG, "no session: the match socket will be refused");
}

/* ---- the match socket ---------------------------------------------------- */
static void on_ws(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg; (void)base;
  esp_websocket_event_data_t *d = data;
  if (id != WEBSOCKET_EVENT_DATA || d->op_code != 0x02) return;       /* binary frames only */
  if (d->payload_len > (int)sizeof packet) return;                    /* no packet is that long */
  memcpy(packet + d->payload_offset, d->data_ptr, d->data_len);       /* a packet may come in pieces */
  if (d->payload_offset + d->data_len < d->payload_len) return;

  xSemaphoreTake(ppu_lock, portMAX_DELAY);
  memcpy(ppu_rx(), packet, d->payload_len);
  u32 flags = ppu_apply(d->payload_len);                              /* whole, or not at all */
  if (!(flags & 128) && !(flags & 16)) { beat_frame = ppu_frame(); beat_us = esp_timer_get_time(); }   /* a tick packet: a beat of the server's clock */
  xSemaphoreGive(ppu_lock);
  if (flags & 128) { u8 ask = C_RESYNC; esp_websocket_client_send_bin(ws, (const char *)&ask, 1, portMAX_DELAY); }
}
static void socket_start(void) {
  static char headers[200];
  snprintf(headers, sizeof headers, "Cookie: %s\r\n", cookie);
  esp_websocket_client_config_t cfg = { .uri = "wss://" HOST "/match/" CART "/" ROOM "?t=esp32", .headers = headers,
                                        .crt_bundle_attach = esp_crt_bundle_attach, .reconnect_timeout_ms = 1000 };
  ws = esp_websocket_client_init(&cfg);
  esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, on_ws, NULL);
  esp_websocket_client_start(ws);
}

/* The server tick to draw now: the last beat, plus the time since, at the game's rate. */
static u32 tick_now(void) {
  u32 hz = ppu_tick();
  if (!hz || !beat_us) return ppu_frame();
  return beat_frame + (u32)((esp_timer_get_time() - beat_us) * hz / 1000000);
}

/* ---- display --------------------------------------------------------------- */
static void display_start(void) {
  spi_bus_config_t bus = { .sclk_io_num = PIN_LCD_CLK, .mosi_io_num = PIN_LCD_MOSI, .miso_io_num = -1,
                           .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = SIDE * 40 * 2 };
  ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));
  esp_lcd_panel_io_handle_t io;
  esp_lcd_panel_io_spi_config_t io_cfg = { .dc_gpio_num = PIN_LCD_DC, .cs_gpio_num = PIN_LCD_CS, .pclk_hz = 40 * 1000 * 1000,
                                           .lcd_cmd_bits = 8, .lcd_param_bits = 8, .spi_mode = 0, .trans_queue_depth = 10 };
  ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io_cfg, &io));
  esp_lcd_panel_dev_config_t dev = { .reset_gpio_num = PIN_LCD_RST, .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB, .bits_per_pixel = 16 };
  ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &dev, &panel));
  esp_lcd_panel_reset(panel);
  esp_lcd_panel_init(panel);
  esp_lcd_panel_invert_color(panel, true);
  esp_lcd_panel_disp_on_off(panel, true);
}
static void draw(void) {
  xSemaphoreTake(ppu_lock, portMAX_DELAY);
  raster_frame(frame, SIDE, ppu_view(tick_now()), ppu_strs(), ppu_pal());
  xSemaphoreGive(ppu_lock);
  for (u32 i = 0; i < SIDE * SIDE; i++) frame[i] = (u16)((frame[i] << 8) | (frame[i] >> 8));    /* the panel wants the high byte first */
  for (int y = 0; y < SIDE; y += 40) esp_lcd_panel_draw_bitmap(panel, 0, y, SIDE, y + 40, frame + y * SIDE);
}

/* ---- buttons -> the input byte (sdk/console.h) ---------------------------- */
static u8 read_input(void) {
  u8 on[9];
  for (int i = 0; i < 9; i++) on[i] = gpio_get_level(PIN_BTN[i]) == 0;
  int dx = on[1] - on[3], dy = on[2] - on[0];
  static const i8 DIR[3][3] = { { DIR_UL, DIR_U, DIR_UR }, { DIR_L, -1, DIR_R }, { DIR_DL, DIR_D, DIR_DR } };
  i8 dir = DIR[dy + 1][dx + 1];
  u8 action = on[6] ? 1 : on[7] ? 2 : on[8] ? 3 : 0;
  return (u8)((dir >= 0 ? 8 | dir : 0) | (on[4] ? IN_A : 0) | (on[5] ? IN_B : 0) | (action << 6));
}

void app_main(void) {
  esp_err_t nvs = nvs_flash_init();
  if (nvs == ESP_ERR_NVS_NO_FREE_PAGES || nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); nvs_flash_init(); }
  for (int i = 0; i < 9; i++) { gpio_set_direction(PIN_BTN[i], GPIO_MODE_INPUT); gpio_set_pull_mode(PIN_BTN[i], GPIO_PULLUP_ONLY); }
  ppu_lock = xSemaphoreCreateMutex();
  frame = heap_caps_malloc(SIDE * SIDE * sizeof *frame, MALLOC_CAP_DMA);
  if (!frame) { ESP_LOGE(TAG, "no memory for the frame: this needs a board with PSRAM"); return; }

  display_start();
  wifi_start();
  session();
  socket_start();

  u8 sent = 0;
  for (;;) {
    u8 in = read_input();
    if (in != sent && esp_websocket_client_is_connected(ws)) {       /* sent only when it changes */
      u8 msg[3] = { C_IN, in, (u8)tick_now() };
      esp_websocket_client_send_bin(ws, (const char *)msg, 3, portMAX_DELAY);
      sent = in;
    }
    if (!esp_websocket_client_is_connected(ws)) sent = 0;            /* the server starts from "nothing pressed" */
    draw();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}
