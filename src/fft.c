#include "fft.h"

#include <assert.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static int bit_reverse(int x, int bits)
{
    int result = 0;
    for (int i = 0; i < bits; i++)
    {
        result = (result << 1) | (x & 1);
        x >>= 1;
    }
    return result;
}

void fft_forward(Complex *buf, int n)
{
    assert(n > 0 && (n & (n - 1)) == 0 && "fft_forward: n must be power of two, no exception");

    int bits = 0;
    while ((1 << bits) < n)
        bits++;

    for (int i = 0; i < n; i++)
    {
        int j = bit_reverse(i, bits);
        if (j > i)
        {
            Complex tmp = buf[i];
            buf[i] = buf[j];
            buf[j] = tmp;
        }
    }

    for (int size = 2; size <= n; size <<= 1)
    {
        int half = size / 2;
        float theta = -2.0f * (float)M_PI / (float)size;
        Complex wn = {cosf(theta), sinf(theta)};

        for (int start = 0; start < n; start += size)
        {
            Complex w = {1.0f, 0.0f};
            for (int k = 0; k < half; k++)
            {
                Complex even = buf[start + k];
                Complex odd = buf[start + k + half];

                Complex t;
                t.re = odd.re * w.re - odd.im * w.im;
                t.im = odd.re * w.im + odd.im * w.re;

                buf[start + k].re = even.re + t.re;
                buf[start + k].im = even.im + t.im;
                buf[start + k + half].re = even.re - t.re;
                buf[start + k + half].im = even.im - t.im;

                float w_re = w.re * wn.re - w.im * wn.im;
                float w_im = w.re * wn.im + w.im * wn.re;
                w.re = w_re;
                w.im = w_im;
            }
        }
    }
}

void fft_apply_hann_window(float *samples, int n)
{
    for (int i = 0; i < n; i++)
    {
        float mult = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * (float)i / (float)(n - 1)));
        samples[i] *= mult;
    }
}
