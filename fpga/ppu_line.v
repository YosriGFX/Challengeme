// ppu_line.v — the FPGA client's PPU: the OP buffer drawn one screen line at a time.
//
// NOT SIMULATED OR SYNTHESIZED where this was written: no Verilog tool was allowed. It was
// written by reading, as a twin of hardware/raster.c at 256 x 256 pixels: the same
// integer rules in the same order, so that the two can be compared pixel for pixel once a
// simulator is at hand (`make hardware` writes the C client's frames).
//
// The split it assumes: a small processor next to the FPGA does the network and runs
// ppu/ppu.c (packets, transitions, Motion OPs). Once per tick it copies what ppu_view(tick)
// returns (256 OPs of 8 bytes) into this module's OP memory, the 16 strings into the string
// memory, and the 8 palette colors as RGB888. The FPGA draws: for every screen line it goes
// through the 256 slots in order (slot order is layer order) and paints each OP's part of
// that line into a line buffer, which the display side reads while the next line is made.
//
// Every OP is broken into a few primitives, exactly as raster.c draws it:
//   BOX  (x, y, w, h)          a filled rectangle; an outline is four of them, inside the box
//   DISC (cx, cy, rout, rin)   a filled circle, or a ring when rin > 0
//   TRI  (3 points)            a filled triangle; a diamond is two
//   SEG  (a, b, r)             a stroke with round ends: lines, outlines, and every letter
// Positions are in 1/16 of a console unit, the centre of pixel i is at 16 i + 8.
// For each primitive the module finds the pixels of this line inside its bounding box and
// tests each one: one clock per pixel. An empty slot costs 4 clocks, any other 26 to read.
// `make fpga-check` compares it with raster.c pixel for pixel (needs Icarus Verilog).
//
// The tests use 64-bit products, like raster.c. That is many multipliers in one clock: a
// real build would pipeline the test or share one multiplier over a few clocks.
module ppu_line (
  input  wire        clk,
  input  wire        rst,

  // OP memory, from the processor: address = slot * 8 + byte (0 opcode, 1 color, 2..7 params)
  input  wire        op_we,
  input  wire [10:0] op_addr,
  input  wire [7:0]  op_data,
  // strings: address = string * 16 + character
  input  wire        str_we,
  input  wire [7:0]  str_addr,
  input  wire [7:0]  str_data,
  // palette: role 1..7 as RGB888 (role 0 is black and cannot be written)
  input  wire        pal_we,
  input  wire [2:0]  pal_addr,
  input  wire [23:0] pal_data,

  // draw one line: pulse line_start with its y (0..255). line_done goes high when it is ready.
  input  wire        line_start,
  input  wire [7:0]  line_y,
  output reg         line_done,

  // the finished line, read by the display side: x in, RGB565 out one clock later
  input  wire [7:0]  px_x,
  output reg  [15:0] px_rgb
);
  localparam [7:0] OP_RECT = 8'd1, OP_CIRC = 8'd2, OP_TRI = 8'd3, OP_DIAM = 8'd4, OP_LINE = 8'd5, OP_POINT = 8'd6, OP_TEXT = 8'd7;
  localparam [1:0] K_BOX = 2'd0, K_DISC = 2'd1, K_TRI = 2'd2, K_SEG = 2'd3;
  localparam [4:0] S_IDLE = 5'd0, S_CLEAR = 5'd1, S_FETCH = 5'd2, S_WAIT = 5'd3, S_KEEP = 5'd4, S_DECODE = 5'd5,
                   S_PRIM = 5'd6, S_BBOX = 5'd7, S_SPAN = 5'd8, S_AFTER = 5'd9, S_NEXT = 5'd10,
                   S_TFETCH = 5'd11, S_TWAIT = 5'd12, S_TKEEP = 5'd13, S_TINIT = 5'd14, S_TCHAR = 5'd15,
                   S_TGWAIT = 5'd16, S_TGLYPH = 5'd17, S_TSTROKE = 5'd18, S_TSWAIT = 5'd19, S_TSKEEP = 5'd20;

  // ---- memories ---------------------------------------------------------------------
  reg [7:0]  ops  [0:2047];
  reg [7:0]  strs [0:255];
  reg [23:0] pal  [0:7];
  reg [15:0] line [0:255];
  `include "font_rom.vh"          // font_at, font_st: made by font/build.py

  reg [10:0] op_rd;  reg [7:0] op_q;
  reg [7:0]  str_rd; reg [7:0] str_q;
  reg [6:0]  fat_rd; reg [15:0] fat_q;
  reg [10:0] fst_rd; reg [15:0] fst_q;

  always @(posedge clk) begin
    if (op_we) ops[op_addr] <= op_data;
    if (str_we) strs[str_addr] <= str_data;
    if (pal_we && pal_addr != 3'd0) pal[pal_addr] <= pal_data;
    op_q   <= ops[op_rd];            // every read answers one clock after its address is set
    str_q  <= strs[str_rd];
    fat_q  <= font_at[fat_rd];
    fst_q  <= font_st[fst_rd];
    px_rgb <= line[px_x];
  end

  // ---- the slot being drawn ---------------------------------------------------------
  reg [4:0] state;
  reg [7:0] y, slot, x, xend;
  reg [3:0] idx;                     // byte of the slot (0..7), or character of a string (0..15)
  reg [7:0] b0, b1, b2, b3, b4, b5, b6, b7;
  reg [2:0] k;                       // primitive of the OP
  reg [15:0] ink;

  // the parameters in 1/16 units, and the pen
  wire [2:0] wid = {1'b0, b1[7:6]} + 3'd1;                         // stroke width 1..4 units
  wire signed [31:0] qa = {20'd0, b2, 4'd0}, qb = {20'd0, b3, 4'd0}, qc = {20'd0, b4, 4'd0};
  wire signed [31:0] qd = {20'd0, b5, 4'd0}, qe = {20'd0, b6, 4'd0}, qf = {20'd0, b7, 4'd0};
  wire signed [31:0] wq = {25'd0, wid, 4'd0};                      // the pen
  wire signed [31:0] hq = {26'd0, wid, 3'd0};                      // half the pen
  wire signed [31:0] hc = {21'd0, b4, 3'd0}, hd = {21'd0, b5, 3'd0};      // half width / height of a diamond

  // the color: role 0 is black, otherwise the palette at 25 / 50 / 75 / 100 percent
  wire [23:0] pc  = pal[b1[2:0]];
  wire [2:0]  lvl = {1'b0, b1[4:3]} + 3'd1;
  wire [10:0] sr = pc[23:16] * lvl, sg = pc[15:8] * lvl, sb = pc[7:0] * lvl;
  wire [7:0]  r8 = sr[9:2], g8 = sg[9:2], c8 = sb[9:2];
  wire [15:0] ink_c = (b1[2:0] == 3'd0) ? 16'd0 : {r8[7:3], g8[7:2], c8[7:3]};

  // ---- primitive k of this OP (everything but text) ------------------------------------
  reg [1:0] n_kind; reg [2:0] n_count;
  reg signed [31:0] n0, n1, n2, n3, n4, n5;
  always @* begin
    n_kind = K_BOX; n_count = 3'd0;
    n0 = 0; n1 = 0; n2 = 0; n3 = 0; n4 = 0; n5 = 0;
    case (b0)
      OP_RECT:
        if (b1[5]) begin n_count = 3'd1; n0 = qa; n1 = qb; n2 = qc; n3 = qd; end
        else begin                                   // an outline: four boxes inside the rectangle
          n_count = 3'd4;
          case (k)
            3'd0: begin n0 = qa;           n1 = qb;           n2 = qc; n3 = wq; end
            3'd1: begin n0 = qa;           n1 = qb + qd - wq; n2 = qc; n3 = wq; end
            3'd2: begin n0 = qa;           n1 = qb;           n2 = wq; n3 = qd; end
            default: begin n0 = qa + qc - wq; n1 = qb;        n2 = wq; n3 = qd; end
          endcase
        end
      OP_CIRC: begin
        n_count = 3'd1; n_kind = K_DISC; n0 = qa; n1 = qb;
        if (b1[5]) begin n2 = qc; n3 = 0; end else begin n2 = qc + hq; n3 = qc - hq; end
      end
      OP_TRI:
        if (b1[5]) begin n_count = 3'd1; n_kind = K_TRI; n0 = qa; n1 = qb; n2 = qc; n3 = qd; n4 = qe; n5 = qf; end
        else begin
          n_count = 3'd3; n_kind = K_SEG; n4 = hq;
          case (k)
            3'd0: begin n0 = qa; n1 = qb; n2 = qc; n3 = qd; end
            3'd1: begin n0 = qc; n1 = qd; n2 = qe; n3 = qf; end
            default: begin n0 = qe; n1 = qf; n2 = qa; n3 = qb; end
          endcase
        end
      OP_DIAM:                                       // points: top, right, bottom, left
        if (b1[5]) begin
          n_count = 3'd2; n_kind = K_TRI;
          n0 = qa; n1 = qb - hd;                     // both halves start at the top
          if (k == 3'd0) begin n2 = qa + hc; n3 = qb;      n4 = qa;      n5 = qb + hd; end
          else           begin n2 = qa;      n3 = qb + hd; n4 = qa - hc; n5 = qb;      end
        end else begin
          n_count = 3'd4; n_kind = K_SEG; n4 = hq;
          case (k)
            3'd0: begin n0 = qa;      n1 = qb - hd; n2 = qa + hc; n3 = qb;      end
            3'd1: begin n0 = qa + hc; n1 = qb;      n2 = qa;      n3 = qb + hd; end
            3'd2: begin n0 = qa;      n1 = qb + hd; n2 = qa - hc; n3 = qb;      end
            default: begin n0 = qa - hc; n1 = qb;   n2 = qa;      n3 = qb - hd; end
          endcase
        end
      OP_LINE:  begin n_count = 3'd1; n_kind = K_SEG;  n0 = qa; n1 = qb; n2 = qc; n3 = qd; n4 = hq; end
      OP_POINT: begin n_count = 3'd1; n_kind = K_DISC; n0 = qa; n1 = qb; n2 = hq; n3 = 0; end
      default: ;                                     // NOP, TEXT (drawn below), anything unknown
    endcase
  end

  // ---- the primitive being drawn, its pixels on this line, and the test of one pixel --------
  reg [1:0] pk;
  reg signed [31:0] p0, p1, p2, p3, p4, p5;

  // a q value to a pixel, rounding toward zero like C
  function signed [31:0] px_of;
    input signed [31:0] q;
    px_of = (q < 0) ? -((-q) >>> 4) : (q >>> 4);
  endfunction
  function signed [31:0] min2; input signed [31:0] a, b; min2 = (a < b) ? a : b; endfunction
  function signed [31:0] max2; input signed [31:0] a, b; max2 = (a > b) ? a : b; endfunction

  reg signed [31:0] bx0, bx1, by0, by1, xlo, xhi, ylo, yhi;
  reg bvalid;
  always @* begin
    bvalid = 1'b1;
    case (pk)
      K_BOX:  begin bx0 = p0; bx1 = p0 + p2; by0 = p1; by1 = p1 + p3; bvalid = (p2 > 0) && (p3 > 0); end
      K_DISC: begin bx0 = p0 - p2; bx1 = p0 + p2; by0 = p1 - p2; by1 = p1 + p2; end
      K_TRI:  begin bx0 = min2(p0, min2(p2, p4)); bx1 = max2(p0, max2(p2, p4)); by0 = min2(p1, min2(p3, p5)); by1 = max2(p1, max2(p3, p5)); end
      default: begin bx0 = min2(p0, p2) - p4; bx1 = max2(p0, p2) + p4; by0 = min2(p1, p3) - p4; by1 = max2(p1, p3) + p4; end
    endcase
    xlo = max2(px_of(bx0) - 1, 0); xhi = min2(px_of(bx1) + 1, 255);
    ylo = max2(px_of(by0) - 1, 0); yhi = min2(px_of(by1) + 1, 255);
  end
  wire signed [31:0] ys = {24'd0, y};
  wire here = bvalid && (ys >= ylo) && (ys <= yhi) && (xlo <= xhi);

  wire signed [31:0] cx = {20'd0, x, 4'b1000};       // the centre of the pixel under test
  wire signed [31:0] cy = {20'd0, y, 4'b1000};
  reg signed [63:0] dx, dy, d2, o2, i2, ux, uy, len2, r2, t, ex, ey, s1, s2, s3;
  reg cov;
  always @* begin
    dx = cx - p0; dy = cy - p1; d2 = dx * dx + dy * dy;
    o2 = 0; i2 = 0; ux = 0; uy = 0; len2 = 0; r2 = 0; t = 0; ex = 0; ey = 0; s1 = 0; s2 = 0; s3 = 0;
    case (pk)
      K_BOX: cov = (cx >= p0) && (cx < p0 + p2) && (cy >= p1) && (cy < p1 + p3);
      K_DISC: begin
        o2 = p2 * p2;
        i2 = (p3 > 0) ? p3 * p3 : -64'sd1;
        cov = (d2 <= o2) && (d2 >= i2);
      end
      K_TRI: begin                                   // on the same side of all three edges
        s1 = (p2 - p0) * (cy - p1) - (p3 - p1) * (cx - p0);
        s2 = (p4 - p2) * (cy - p3) - (p5 - p3) * (cx - p2);
        s3 = (p0 - p4) * (cy - p5) - (p1 - p5) * (cx - p4);
        cov = ((s1 >= 0) && (s2 >= 0) && (s3 >= 0)) || ((s1 <= 0) && (s2 <= 0) && (s3 <= 0));
      end
      default: begin                                 // within r of the segment
        ux = p2 - p0; uy = p3 - p1; len2 = ux * ux + uy * uy; r2 = p4 * p4;
        t = dx * ux + dy * uy;
        ex = cx - p2; ey = cy - p3;
        if (t <= 0) cov = (d2 <= r2);
        else if (t >= len2) cov = (ex * ex + ey * ey <= r2);
        else cov = (d2 * len2 - t * t <= r2 * len2);
      end
    endcase
  end

  // ---- text: one SEG per stroke of every letter ---------------------------------------
  reg [7:0] tbuf [0:15];
  reg tmode;
  reg [4:0] tlen, ci, gcount, sj;
  reg [10:0] gfirst;
  reg signed [31:0] tx, ty, adv, cell, pen;

  integer ii;
  reg [4:0] tlen_c; reg found;
  always @* begin                                    // the string ends at its first 0
    tlen_c = 5'd16; found = 1'b0;
    for (ii = 0; ii < 16; ii = ii + 1)
      if (!found && tbuf[ii] == 8'd0) begin tlen_c = ii[4:0]; found = 1'b1; end
  end
  // size b4: 0.6 em per letter, the 4 x 6 grid is 0.7 em high, the pen 0.1 em (at least 1/4 unit)
  wire [15:0] adv_c  = (b4 * 16'd96) / 16'd10;
  wire [15:0] cell_c = (b4 * 16'd112) / 16'd60;
  wire [15:0] pen0   = (b4 * 16'd16) / 16'd20;
  wire signed [31:0] adv_s  = {16'd0, adv_c};
  wire signed [31:0] cell_s = {16'd0, cell_c};
  wire signed [31:0] pen_s  = {16'd0, (pen0 > 16'd4) ? pen0 : 16'd4};
  wire signed [31:0] tlen_s = {27'd0, tlen_c};
  wire signed [31:0] shift_c = (b5 == 8'd1) ? (tlen_s * adv_s) / 2 : (b5 == 8'd2) ? tlen_s * adv_s : 0;   // centre, right
  wire signed [31:0] tx_c = qa - shift_c + (adv_s - 4 * cell_s) / 2;

  wire [7:0] ch  = tbuf[ci[3:0]];
  wire [7:0] chu = (ch >= 8'h61 && ch <= 8'h7A) ? ch - 8'd32 : ch;            // a small letter shows its capital
  wire [7:0] chg = (chu < 8'h20 || chu > 8'h7E) ? 8'h3F : chu;
  wire [7:0] ga = fst_q[15:8], gb = fst_q[7:0];                                // the stroke's two points
  wire signed [31:0] gax = {28'd0, ga[7:4]}, gay = {28'd0, ga[3:0]} - 1;
  wire signed [31:0] gbx = {28'd0, gb[7:4]}, gby = {28'd0, gb[3:0]} - 1;

  // ---- the machine --------------------------------------------------------------------
  always @(posedge clk) begin
    if (rst) begin
      state <= S_IDLE; line_done <= 1'b0; tmode <= 1'b0;
    end else begin
      case (state)
        S_IDLE: if (line_start) begin y <= line_y; x <= 8'd0; line_done <= 1'b0; state <= S_CLEAR; end

        S_CLEAR: begin                               // every line starts black
          line[x] <= 16'd0;
          if (x == 8'd255) begin slot <= 8'd0; idx <= 4'd0; state <= S_FETCH; end
          x <= x + 8'd1;
        end

        // read the slot's 8 bytes; an empty slot stops after the first
        S_FETCH: begin op_rd <= {slot, idx[2:0]}; state <= S_WAIT; end
        S_WAIT:  state <= S_KEEP;
        S_KEEP: begin
          case (idx[2:0])
            3'd0: b0 <= op_q; 3'd1: b1 <= op_q; 3'd2: b2 <= op_q; 3'd3: b3 <= op_q;
            3'd4: b4 <= op_q; 3'd5: b5 <= op_q; 3'd6: b6 <= op_q; default: b7 <= op_q;
          endcase
          if (idx == 4'd0 && op_q == 8'd0) state <= S_NEXT;
          else if (idx == 4'd7) state <= S_DECODE;
          else begin idx <= idx + 4'd1; state <= S_FETCH; end
        end

        S_DECODE: begin
          ink <= ink_c; k <= 3'd0; idx <= 4'd0;
          state <= (b0 == OP_TEXT) ? S_TFETCH : S_PRIM;
        end

        S_PRIM:
          if (k >= n_count) state <= S_NEXT;
          else begin pk <= n_kind; p0 <= n0; p1 <= n1; p2 <= n2; p3 <= n3; p4 <= n4; p5 <= n5; state <= S_BBOX; end

        S_BBOX:
          if (here) begin x <= xlo[7:0]; xend <= xhi[7:0]; state <= S_SPAN; end
          else state <= S_AFTER;

        S_SPAN: begin                                // one pixel per clock
          if (cov) line[x] <= ink;
          if (x == xend) state <= S_AFTER; else x <= x + 8'd1;
        end

        S_AFTER:
          if (tmode) begin sj <= sj + 5'd1; state <= S_TSTROKE; end
          else begin k <= k + 3'd1; state <= S_PRIM; end

        S_NEXT: begin                                // the next slot is the next layer
          idx <= 4'd0; tmode <= 1'b0;
          if (slot == 8'd255) begin line_done <= 1'b1; state <= S_IDLE; end
          else begin slot <= slot + 8'd1; state <= S_FETCH; end
        end

        // text: read the string, then every stroke of every letter is a SEG
        S_TFETCH: begin str_rd <= {b6[3:0], idx}; state <= S_TWAIT; end
        S_TWAIT:  state <= S_TKEEP;
        S_TKEEP: begin
          tbuf[idx] <= str_q;
          if (idx == 4'd15) state <= S_TINIT; else begin idx <= idx + 4'd1; state <= S_TFETCH; end
        end
        S_TINIT: begin
          tlen <= tlen_c; adv <= adv_s; cell <= cell_s; pen <= pen_s;
          tx <= tx_c; ty <= qb; ci <= 5'd0; tmode <= 1'b1;
          state <= S_TCHAR;
        end
        S_TCHAR:
          if (ci == tlen) state <= S_NEXT;
          else begin fat_rd <= chg[6:0] - 7'h20; state <= S_TGWAIT; end
        S_TGWAIT: state <= S_TGLYPH;
        S_TGLYPH: begin gfirst <= fat_q[15:5]; gcount <= fat_q[4:0]; sj <= 5'd0; state <= S_TSTROKE; end
        S_TSTROKE:
          if (sj == gcount) begin tx <= tx + adv; ci <= ci + 5'd1; state <= S_TCHAR; end
          else begin fst_rd <= gfirst + {6'd0, sj}; state <= S_TSWAIT; end
        S_TSWAIT: state <= S_TSKEEP;
        S_TSKEEP: begin                              // the grid is y up, the screen y down
          pk <= K_SEG;
          p0 <= tx + gax * cell; p1 <= ty - gay * cell;
          p2 <= tx + gbx * cell; p3 <= ty - gby * cell;
          p4 <= pen;
          state <= S_BBOX;
        end

        default: state <= S_IDLE;
      endcase
    end
  end
endmodule
