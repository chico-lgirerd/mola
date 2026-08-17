#include "bars.h"

#include <math.h>
#include <stdlib.h>

int bars_init(BarMapper *bm, int num_bars, int fft_size, int sample_rate,
              float min_freq, float max_freq)
{
    bm->ranges = calloc((size_t)num_bars, sizeof(BarBinRange));
    bm->smoothed = calloc((size_t)num_bars, sizeof(float));
    if (!bm->ranges || !bm->smoothed)
    {
        free(bm->ranges);
        free(bm->smoothed);
        bm->ranges = NULL;
        bm->smoothed = NULL;
        return -1;
    }
    bm->count = num_bars;

    float bin_hz = (float)sample_rate / (float)fft_size;
    int max_bin = fft_size / 2;
    float log_min = logf(min_freq);
    float log_max = logf(max_freq);

    int next_free_bin = 1;

    for (int i = 0; i < num_bars; i++)
    {
        float f_lo = expf(log_min + (log_max - log_min) * (float)i / (float)num_bars);
        float f_hi = expf(log_min + (log_max - log_min) * (float)(i + 1) / (float)num_bars);

        int bin_lo = (int)(f_lo / bin_hz + 0.5f);
        int bin_hi = (int)(f_hi / bin_hz + 0.5f);

        if (bin_lo < next_free_bin)
            bin_lo = next_free_bin;
        if (bin_hi <= bin_lo)
            bin_hi = bin_lo + 1;
        if (bin_hi > max_bin) // avoid going above top of the window
            bin_hi = max_bin;
        if (bin_lo >= max_bin)
            bin_lo = max_bin - 1;
        if (bin_hi <= bin_lo)
            bin_hi = bin_lo + 1;

        bm->ranges[i].bin_lo = bin_lo;
        bm->ranges[i].bin_hi = bin_hi;
        next_free_bin = bin_hi;
    }
    return 0;
}

void bars_update(BarMapper *bm, const float *magnitudes, float sensitivity,
                 float attack, float release)
{
    for (int i = 0; i < bm->count; i++)
    {
        BarBinRange r = bm->ranges[i];
        float peak = 0.0f;
        for (int b = r.bin_lo; b < r.bin_hi; b++)
        {
            if (magnitudes[b] > peak)
                peak = magnitudes[b];
        }

        float value = sqrtf(peak) * sensitivity;
        if (value > 1.0f)
            value = 1.0f;
        if (value < 0.0f)
            value = 0.0f;

        float prev = bm->smoothed[i];
        float rate = (value > prev) ? attack : release;
        bm->smoothed[i] = prev + (value - prev) * rate;
    }
}

void bars_free(BarMapper *bm)
{
    free(bm->ranges);
    free(bm->smoothed);
    bm->ranges = NULL;
    bm->smoothed = NULL;
    bm->count = 0;
}
