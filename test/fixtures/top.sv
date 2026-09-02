module top(input logic a, output logic b);
  always_comb b = ~a;
endmodule
