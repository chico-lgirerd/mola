#ifndef AUDIO_H
#define AUDIO_H

#include <pulse/simple.h>
#include <pthread.h>
#include <stddef.h>

typedef struct
{
    pa_simple *pa;
    pthread_t thread;
    pthread_mutex_t lock;
    volatile int running;

    float *ring;
    int ring_capacity; 
    int ring_write_pos;

    int sample_rate;
} AudioCapture;

// get default monitor with pactl
int audio_find_default_monitor(char *out, size_t outsz);
void audio_print_sources(void);

int audio_capture_start(AudioCapture *cap, const char *device, int sample_rate);

void audio_capture_get_window(AudioCapture *cap, float *out, int n);

void audio_capture_stop(AudioCapture *cap);

#endif
