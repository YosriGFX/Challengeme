// ppu_line.v — the start of an FPGA client: the PPU's drawing, one screen line at a time.
//
// NOT SIMULATED OR SYNTHESIZED where this was written: there was no Verilog tool. Read it
// as a design to check, not as a proven core.
//
// The split it assumes: a small processor next to the FPGA does the network and runs
// ppu/ppu.c (packets, transitions, Motion OPs). Once per tick it copies what ppu_view(tick)
// returns, 256 OPs of 8 bytes, into this module's OP memory, and the 8 palette colors as
// RGB565. The FPGA then draws: for every screen line it goes through the 256 slots in
// order (slot order is layer order) and paints each OP's part of that line into a line
// buffer, which the display side reads while the next line is prepared.
//
// What is here: the OP memory, the palette with the four brightness levels, the line
// buffer, and the filled RECT (also the eraser when its role is black). CIRC, TRI, DIAM,
// LINE, POINT, TEXT and outlines are not here yet. Each of them is one more case in the
// TEST state that gives, for this line, a first and a last x to paint: hardware/raster.c
// has the integer rules for all of them.
//
// Cost: 26 clocks to read and test a slot (3 per byte), plus one clock per pixel a
// rectangle covers on the line. A screen full of wide rectangles needs more clocks per line than a 60 Hz display
// leaves at 50 MHz; games on this console draw far less than that.
module ppu_line (
  input  wire        clk,
  input  wire        rst,

  // OP memory, written by the processor: address = slot * 8 + byte (0 opcode, 1 color, 2.. params)
  input  wire        op_we,
  input  wire [10:0] op_addr,
  input  wire [7:0]  op_data,

  // palette, written by the processor: role 1..7 as RGB565 (role 0 is black and cannot be written)
  input  wire        pal_we,
  input  wire [2:0]  pal_addr,
  input  wire [15:0] pal_data,

  // draw one line: pulse line_start with its y (0..255, console units). line_done goes high when it is ready.
  input  wire        line_start,
  input  wire [7:0]  line_y,
  output reg         line_done,

  // the finished line, read by the display side: x in, RGB565 out one clock later
  input  wire [7:0]  px_x,
  output reg  [15:0] px_rgb
);
  localparam OP_RECT = 8'd1;
  localparam S_IDLE = 3'd0, S_CLEAR = 3'd1, S_ADDR = 3'd2, S_READ = 3'd3, S_TEST = 3'd4, S_FILL = 3'd5, S_NEXT = 3'd6;

  reg [7:0]  ops [0:2047];        // 256 slots x 8 bytes
  reg [15:0] pal [0:7];
  reg [15:0] line [0:255];        // the line being prepared

  reg [2:0]  state;
  reg [7:0]  y, slot, x, x_last;
  reg [3:0]  idx;                 // which byte of the slot is being read (0..7), 8 = all read
  reg [10:0] rd_addr;
  reg [7:0]  rd_data;
  reg [7:0]  b [0:7];             // the slot under test
  reg [15:0] ink;

  // one RGB565 color at 25 / 50 / 75 / 100 percent
  function [15:0] shade;
    input [15:0] c;
    input [1:0]  level;
    reg   [6:0]  r, bl;
    reg   [7:0]  g;
    begin
      r  = c[15:11] * (level + 3'd1);
      g  = c[10:5]  * (level + 3'd1);
      bl = c[4:0]   * (level + 3'd1);
      shade = {r[6:2], g[7:2], bl[6:2]};
    end
  endfunction

  // the last x a rectangle covers: x + w - 1, never past the right edge
  wire [8:0] rect_end = {1'b0, b[2]} + {1'b0, b[4]} - 9'd1;
  wire [8:0] rect_bottom = {1'b0, b[3]} + {1'b0, b[5]};
  wire       rect_here = (b[0] == OP_RECT) && b[1][5] && (b[4] != 8'd0) && (b[5] != 8'd0)
                         && (y >= b[3]) && ({1'b0, y} < rect_bottom);

  always @(posedge clk) begin
    if (op_we) ops[op_addr] <= op_data;
    if (pal_we && pal_addr != 3'd0) pal[pal_addr] <= pal_data;
    rd_data <= ops[rd_addr];
    px_rgb  <= line[px_x];
  end

  always @(posedge clk) begin
    if (rst) begin
      state <= S_IDLE; line_done <= 1'b0;
    end else begin
      case (state)
        S_IDLE: if (line_start) begin
          y <= line_y; x <= 8'd0; line_done <= 1'b0; state <= S_CLEAR;
        end
        S_CLEAR: begin                               // every line starts black
          line[x] <= 16'd0;
          if (x == 8'd255) begin slot <= 8'd0; idx <= 4'd0; state <= S_ADDR; end
          x <= x + 8'd1;
        end
        S_ADDR: begin                                // ask the OP memory for one byte of the slot
          rd_addr <= {slot, idx[2:0]};
          state <= S_READ;
        end
        S_READ: state <= S_TEST;                     // the memory answers one clock after it was asked
        S_TEST: begin
          if (idx != 4'd8) begin                     // still reading: keep this byte, ask for the next
            b[idx[2:0]] <= rd_data;
            idx <= idx + 4'd1;
            state <= (idx == 4'd7) ? S_TEST : S_ADDR;
          end else if (rect_here) begin              // all 8 bytes are in: does it touch this line?
            ink    <= (b[1][2:0] == 3'd0) ? 16'd0 : shade(pal[b[1][2:0]], b[1][4:3]);    // role 0 is always black
            x      <= b[2];
            x_last <= rect_end[8] ? 8'd255 : rect_end[7:0];
            state  <= S_FILL;
          end else state <= S_NEXT;
        end
        S_FILL: begin
          line[x] <= ink;
          if (x == x_last) state <= S_NEXT; else x <= x + 8'd1;
        end
        S_NEXT: begin                                // the next slot is the next layer
          idx <= 4'd0;
          if (slot == 8'd255) begin line_done <= 1'b1; state <= S_IDLE; end
          else begin slot <= slot + 8'd1; state <= S_ADDR; end
        end
        default: state <= S_IDLE;
      endcase
    end
  end
endmodule
