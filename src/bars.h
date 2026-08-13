#ifndef BARS_H
#define BARS_H

typedef struct
{
    int bin_lo;
    int bin_hi;
} BarBinRange;

typedef struct
{
    BarBinRange *ranges;
    float *smoothed;
    int count;
} BarMapper;

int bars_init(BarMapper *bm, int num_bars, int fft_size, int sample_rate,
              float min_freq, float max_freq);
void bars_update(BarMapper *bm, const float *magnitudes, float sensitivity,
                 float attack, float release);
void bars_free(BarMapper *bm);

#endif
