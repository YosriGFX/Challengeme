/* esp_stub.h — stand-ins for the ESP-IDF declarations main.c uses, so that the file can be
 * checked as C on a machine with no ESP-IDF (`make esp32-check`). They follow the ESP-IDF 5
 * names and shapes from memory; they prove the file is valid C, not that a board runs it. */
#ifndef ESP_STUB_H
#define ESP_STUB_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_NVS_NO_FREE_PAGES 0x110d
#define ESP_ERR_NVS_NEW_VERSION_FOUND 0x1110
#define ESP_ERROR_CHECK(x) do { esp_err_t e_ = (x); (void)e_; } while (0)
#define ESP_LOGE(tag, ...) ((void)(tag))
/* FreeRTOS */
typedef uint32_t TickType_t; typedef void *SemaphoreHandle_t; typedef void *EventGroupHandle_t;
#define portMAX_DELAY 0xffffffffu
#define pdFALSE 0
#define pdTRUE 1
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))
void vTaskDelay(TickType_t t);
SemaphoreHandle_t xSemaphoreCreateMutex(void); int xSemaphoreTake(SemaphoreHandle_t s, TickType_t t); int xSemaphoreGive(SemaphoreHandle_t s);
EventGroupHandle_t xEventGroupCreate(void); uint32_t xEventGroupSetBits(EventGroupHandle_t g, uint32_t bits);
uint32_t xEventGroupWaitBits(EventGroupHandle_t g, uint32_t bits, int clear, int all, TickType_t t);
/* events, network, Wi-Fi */
typedef const char *esp_event_base_t; typedef void (*esp_event_handler_t)(void *arg, esp_event_base_t base, int32_t id, void *data);
extern esp_event_base_t WIFI_EVENT, IP_EVENT;
enum { WIFI_EVENT_STA_START = 2, WIFI_EVENT_STA_DISCONNECTED = 5, IP_EVENT_STA_GOT_IP = 0, ESP_EVENT_ANY_ID = -1 };
esp_err_t esp_event_loop_create_default(void); esp_err_t esp_event_handler_register(esp_event_base_t b, int32_t id, esp_event_handler_t h, void *arg);
esp_err_t esp_netif_init(void); void *esp_netif_create_default_wifi_sta(void);
typedef struct { int dummy; } wifi_init_config_t;
#define WIFI_INIT_CONFIG_DEFAULT() { 0 }
typedef union { struct { uint8_t ssid[32]; uint8_t password[64]; } sta; } wifi_config_t;
enum { WIFI_MODE_STA = 1, WIFI_IF_STA = 0 };
esp_err_t esp_wifi_init(const wifi_init_config_t *c); esp_err_t esp_wifi_set_mode(int m); esp_err_t esp_wifi_set_config(int ifx, wifi_config_t *c);
esp_err_t esp_wifi_start(void); esp_err_t esp_wifi_connect(void);
esp_err_t nvs_flash_init(void); esp_err_t nvs_flash_erase(void);
int64_t esp_timer_get_time(void);
#define MALLOC_CAP_DMA 8
void *heap_caps_malloc(size_t n, uint32_t caps);
esp_err_t esp_crt_bundle_attach(void *conf);
/* HTTP */
typedef enum { HTTP_EVENT_ON_HEADER = 3 } esp_http_client_event_id_t; typedef enum { HTTP_METHOD_POST = 1 } esp_http_client_method_t;
typedef struct { esp_http_client_event_id_t event_id; char *header_key; char *header_value; } esp_http_client_event_t;
typedef struct { const char *url; esp_http_client_method_t method; esp_err_t (*event_handler)(esp_http_client_event_t *e); esp_err_t (*crt_bundle_attach)(void *conf); } esp_http_client_config_t;
typedef void *esp_http_client_handle_t;
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *c); esp_err_t esp_http_client_perform(esp_http_client_handle_t h); esp_err_t esp_http_client_cleanup(esp_http_client_handle_t h);
/* WebSocket */
typedef void *esp_websocket_client_handle_t;
typedef struct { const char *uri; const char *headers; esp_err_t (*crt_bundle_attach)(void *conf); int reconnect_timeout_ms; } esp_websocket_client_config_t;
typedef struct { const char *data_ptr; int data_len; uint8_t op_code; int payload_len; int payload_offset; } esp_websocket_event_data_t;
enum { WEBSOCKET_EVENT_ANY = -1, WEBSOCKET_EVENT_DATA = 3 };
esp_websocket_client_handle_t esp_websocket_client_init(const esp_websocket_client_config_t *c);
esp_err_t esp_websocket_register_events(esp_websocket_client_handle_t c, int event, esp_event_handler_t h, void *arg);
esp_err_t esp_websocket_client_start(esp_websocket_client_handle_t c); bool esp_websocket_client_is_connected(esp_websocket_client_handle_t c);
int esp_websocket_client_send_bin(esp_websocket_client_handle_t c, const char *data, int len, TickType_t t);
/* GPIO, SPI, display */
typedef int gpio_num_t; enum { GPIO_MODE_INPUT = 1, GPIO_PULLUP_ONLY = 0 };
int gpio_get_level(gpio_num_t pin); esp_err_t gpio_set_direction(gpio_num_t pin, int mode); esp_err_t gpio_set_pull_mode(gpio_num_t pin, int pull);
typedef struct { int sclk_io_num, mosi_io_num, miso_io_num, quadwp_io_num, quadhd_io_num, max_transfer_sz; } spi_bus_config_t;
enum { SPI2_HOST = 1, SPI_DMA_CH_AUTO = 3 };
esp_err_t spi_bus_initialize(int host, const spi_bus_config_t *c, int dma);
typedef void *esp_lcd_panel_io_handle_t; typedef void *esp_lcd_panel_handle_t; typedef uint32_t esp_lcd_spi_bus_handle_t;
typedef struct { int dc_gpio_num, cs_gpio_num; unsigned pclk_hz; int lcd_cmd_bits, lcd_param_bits, spi_mode; size_t trans_queue_depth; } esp_lcd_panel_io_spi_config_t;
typedef struct { int reset_gpio_num; int rgb_ele_order; unsigned bits_per_pixel; } esp_lcd_panel_dev_config_t;
enum { LCD_RGB_ELEMENT_ORDER_RGB = 0 };
esp_err_t esp_lcd_new_panel_io_spi(esp_lcd_spi_bus_handle_t bus, const esp_lcd_panel_io_spi_config_t *c, esp_lcd_panel_io_handle_t *io);
esp_err_t esp_lcd_new_panel_st7789(esp_lcd_panel_io_handle_t io, const esp_lcd_panel_dev_config_t *c, esp_lcd_panel_handle_t *p);
esp_err_t esp_lcd_panel_reset(esp_lcd_panel_handle_t p); esp_err_t esp_lcd_panel_init(esp_lcd_panel_handle_t p);
esp_err_t esp_lcd_panel_invert_color(esp_lcd_panel_handle_t p, bool on); esp_err_t esp_lcd_panel_disp_on_off(esp_lcd_panel_handle_t p, bool on);
esp_err_t esp_lcd_panel_draw_bitmap(esp_lcd_panel_handle_t p, int x0, int y0, int x1, int y1, const void *px);
#endif
