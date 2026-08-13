#ifndef FFT_H
#define FFT_H

typedef struct
{
    float re;
    float im;
} Complex;

void fft_forward(Complex *buf, int n);
void fft_apply_hann_window(float *samples, int n);

#endif
