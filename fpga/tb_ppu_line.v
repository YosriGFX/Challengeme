// tb_ppu_line.v — draws one frame with ppu_line.v, to compare with hardware/raster.c.
// Run by `make fpga-check`. It reads in.ops.hex, in.strs.hex and in.pal.hex (written by
// hardware/out/ref ... 256 <prefix>), draws the 256 lines, and writes out.rgb565.hex.
`timescale 1ns/1ps
module tb;
  reg clk = 1'b0, rst = 1'b1;
  always #5 clk = ~clk;

  reg op_we = 1'b0, str_we = 1'b0, pal_we = 1'b0, line_start = 1'b0;
  reg [10:0] op_addr;  reg [7:0] op_data;
  reg [7:0]  str_addr; reg [7:0] str_data;
  reg [2:0]  pal_addr; reg [23:0] pal_data;
  reg [7:0]  line_y, px_x;
  wire line_done;
  wire [15:0] px_rgb;

  ppu_line dut (.clk(clk), .rst(rst),
    .op_we(op_we), .op_addr(op_addr), .op_data(op_data),
    .str_we(str_we), .str_addr(str_addr), .str_data(str_data),
    .pal_we(pal_we), .pal_addr(pal_addr), .pal_data(pal_data),
    .line_start(line_start), .line_y(line_y), .line_done(line_done),
    .px_x(px_x), .px_rgb(px_rgb));

  reg [7:0]  ops_m  [0:2047];
  reg [7:0]  strs_m [0:255];
  reg [23:0] pal_m  [0:7];
  integer i, yy, xx, f;

  initial begin
    $readmemh("in.ops.hex", ops_m);
    $readmemh("in.strs.hex", strs_m);
    $readmemh("in.pal.hex", pal_m);
    repeat (2) @(negedge clk);
    rst = 1'b0;
    for (i = 0; i < 2048; i = i + 1) begin @(negedge clk); op_we = 1'b1; op_addr = i; op_data = ops_m[i]; end
    @(negedge clk); op_we = 1'b0;
    for (i = 0; i < 256; i = i + 1) begin @(negedge clk); str_we = 1'b1; str_addr = i; str_data = strs_m[i]; end
    @(negedge clk); str_we = 1'b0;
    for (i = 1; i < 8; i = i + 1) begin @(negedge clk); pal_we = 1'b1; pal_addr = i; pal_data = pal_m[i]; end
    @(negedge clk); pal_we = 1'b0;

    f = $fopen("out.rgb565.hex", "w");
    for (yy = 0; yy < 256; yy = yy + 1) begin
      @(negedge clk); line_y = yy; line_start = 1'b1;
      @(negedge clk); line_start = 1'b0;
      wait (line_done);
      for (xx = 0; xx < 256; xx = xx + 1) begin
        @(negedge clk); px_x = xx;
        @(posedge clk); #1;
        $fwrite(f, "%04x\n", px_rgb);
      end
    end
    $fclose(f);
    $finish;
  end
endmodule
