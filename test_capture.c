/* small cave-tool, no window, no pretty picture -- just proof the mic
 * pipe still flow. run it, make noise, watch the star-bars grow. good
 * first thing to try if the real app opens but bars stay flat: this
 * tells you if the problem is capture or the picture-drawing part. */
#define _DEFAULT_SOURCE /* usleep needs this poked under -std=c11 */
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "src/audio.h"
#include "src/bars.h"
#include "src/fft.h"

#define FFT_SIZE 2048

int main(void) {
    AudioCapture cap;
    memset(&cap, 0, sizeof(cap));

    if (audio_capture_start(&cap, NULL, 44100) != 0) {
        fprintf(stderr, "capture start failed\n");
        return 1;
    }

    BarMapper bars;
    bars_init(&bars, 16, FFT_SIZE, 44100, 40.0f, 16000.0f);

    float samples[FFT_SIZE];
    float windowed[FFT_SIZE];
    Complex spectrum[FFT_SIZE];
    float magnitudes[FFT_SIZE / 2];

    for (int frame = 0; frame < 40; frame++) {
        usleep(150000); /* 150ms between reads */

        audio_capture_get_window(&cap, samples, FFT_SIZE);

        float rms = 0.0f;
        for (int i = 0; i < FFT_SIZE; i++) rms += samples[i] * samples[i];
        rms = sqrtf(rms / FFT_SIZE);

        memcpy(windowed, samples, sizeof(samples));
        fft_apply_hann_window(windowed, FFT_SIZE);
        for (int i = 0; i < FFT_SIZE; i++) {
            spectrum[i].re = windowed[i];
            spectrum[i].im = 0.0f;
        }
        fft_forward(spectrum, FFT_SIZE);
        for (int i = 0; i < FFT_SIZE / 2; i++) {
            float re = spectrum[i].re, im = spectrum[i].im;
            magnitudes[i] = sqrtf(re * re + im * im);
        }
        bars_update(&bars, magnitudes, 1.0f, 0.7f, 0.1f);

        float bar_sum = 0.0f;
        for (int i = 0; i < bars.count; i++) bar_sum += bars.smoothed[i];

        printf("frame %2d  raw_rms=%.5f  bar_avg=%.4f  bars: ", frame, rms, bar_sum / bars.count);
        for (int i = 0; i < bars.count; i++) {
            int stars = (int)(bars.smoothed[i] * 10.0f);
            putchar(stars > 0 ? ('0' + (stars > 9 ? 9 : stars)) : '.');
        }
        putchar('\n');
        fflush(stdout);
    }

    bars_free(&bars);
    audio_capture_stop(&cap);
    return 0;
}
