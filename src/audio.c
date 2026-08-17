#include "audio.h"

#include <pulse/error.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define READ_CHUNK_FRAMES 512
#define RING_SLACK 8

int audio_find_default_monitor(char *out, size_t outsz)
{
    FILE *fp = popen("pactl info 2>/dev/null", "r");
    if (!fp)
        return -1;

    char line[512];
    int found = 0;
    const char *prefix = "Default Sink:";
    while (fgets(line, sizeof(line), fp))
    {
        if (strncmp(line, prefix, strlen(prefix)) == 0)
        {
            char *name = line + strlen(prefix);
            while (*name == ' ' || *name == '\t')
                name++;
            size_t len = strlen(name);
            while (len > 0 && (name[len - 1] == '\n' || name[len - 1] == '\r'))
            {
                name[--len] = '\0';
            }
            if (len > 0)
            {
                snprintf(out, outsz, "%s.monitor", name);
                found = 1;
            }
            break;
        }
    }
    pclose(fp);
    return found ? 0 : -1;
}

void audio_print_sources(void)
{
    FILE *fp = popen("pactl list short sources 2>/dev/null", "r");
    if (!fp)
    {
        fprintf(stderr, "no pactl on this machine. need pulseaudio-utils or pipewire-pulse.\n");
        return;
    }
    char line[512];
    int any = 0;
    while (fgets(line, sizeof(line), fp))
    {
        fputs(line, stdout);
        any = 1;
    }
    pclose(fp);
    if (!any)
    {
        fprintf(stderr, "pactl gave nothing back. is pulseaudio or pipewire-pulse running?\n");
    }
}

static void *capture_thread_main(void *arg)
{
    AudioCapture *cap = (AudioCapture *)arg;
    float chunk[READ_CHUNK_FRAMES * 2];

    while (cap->running)
    {
        int err = 0;
        if (pa_simple_read(cap->pa, chunk, sizeof(chunk), &err) < 0)
        {
            fprintf(stderr, "pulse read choked: %s\n", pa_strerror(err));
            break;
        }

        pthread_mutex_lock(&cap->lock);
        for (int i = 0; i < READ_CHUNK_FRAMES; i++)
        {
            float mono = 0.5f * (chunk[i * 2] + chunk[i * 2 + 1]);
            cap->ring[cap->ring_write_pos] = mono;
            cap->ring_write_pos = (cap->ring_write_pos + 1) % cap->ring_capacity;
        }
        pthread_mutex_unlock(&cap->lock);
    }
    return NULL;
}

int audio_capture_start(AudioCapture *cap, const char *device, int sample_rate, int window_size)
{
    char auto_device[256];
    const char *use_device = device;

    if (!use_device)
    {
        if (audio_find_default_monitor(auto_device, sizeof(auto_device)) != 0)
        {
            fprintf(stderr, "could not work out the default sink's monitor via pactl.\n");
            return -1;
        }
        use_device = auto_device;
    }

    pa_sample_spec spec;
    spec.format = PA_SAMPLE_FLOAT32LE;
    spec.rate = (uint32_t)sample_rate;
    spec.channels = 2;

    int err = 0;
    cap->pa = pa_simple_new(NULL, "audiovisualizer", PA_STREAM_RECORD,
                            use_device, "system audio capture", &spec,
                            NULL, NULL, &err);
    if (!cap->pa)
    {
        fprintf(stderr, "pa_simple_new failed for device '%s': %s\n",
                use_device, pa_strerror(err));
        return -1;
    }

    cap->sample_rate = sample_rate;
    cap->ring_capacity = READ_CHUNK_FRAMES * RING_SLACK;
    /* the ring must hold at least one full FFT window, or get_window
     * silently returns a truncated window and the caller's FFT reads
     * uninitialized samples past it */
    if (window_size > cap->ring_capacity)
        cap->ring_capacity = window_size;
    cap->ring = calloc((size_t)cap->ring_capacity, sizeof(float));
    if (!cap->ring)
    {
        fprintf(stderr, "out of memory for ring buffer\n");
        pa_simple_free(cap->pa);
        cap->pa = NULL;
        return -1;
    }
    cap->ring_write_pos = 0;

    if (pthread_mutex_init(&cap->lock, NULL) != 0)
    {
        fprintf(stderr, "could not make mutex\n");
        free(cap->ring);
        cap->ring = NULL;
        pa_simple_free(cap->pa);
        cap->pa = NULL;
        return -1;
    }

    cap->running = 1;
    if (pthread_create(&cap->thread, NULL, capture_thread_main, cap) != 0)
    {
        fprintf(stderr, "could not start capture thread\n");
        cap->running = 0;
        pthread_mutex_destroy(&cap->lock);
        free(cap->ring);
        cap->ring = NULL;
        pa_simple_free(cap->pa);
        cap->pa = NULL;
        return -1;
    }

    return 0;
}

void audio_capture_get_window(AudioCapture *cap, float *out, int n)
{
    if (!cap->ring || n <= 0)
        return;
    if (n > cap->ring_capacity)
        n = cap->ring_capacity;

    pthread_mutex_lock(&cap->lock);

    int start = (cap->ring_write_pos - n + cap->ring_capacity * 4) % cap->ring_capacity;
    for (int i = 0; i < n; i++)
    {
        out[i] = cap->ring[(start + i) % cap->ring_capacity];
    }
    pthread_mutex_unlock(&cap->lock);
}

void audio_capture_stop(AudioCapture *cap)
{
    if (cap->running)
    {
        cap->running = 0;
        pthread_join(cap->thread, NULL);
        pthread_mutex_destroy(&cap->lock);
    }
    if (cap->pa)
    {
        pa_simple_free(cap->pa);
        cap->pa = NULL;
    }
    free(cap->ring);
    cap->ring = NULL;
}
