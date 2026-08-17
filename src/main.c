#include <ctype.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <SDL2/SDL.h>

#include "audio.h"
#include "bars.h"
#include "fft.h"
#include "render.h"

#define DEFAULT_FONT_PATH "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
#define DEFAULT_FONT_SIZE 16
#define BUNDLED_FONT_NAME "Montserrat-SemiBold.ttf"

#define DEFAULT_SAMPLE_RATE 44100
#define FFT_SIZE 16384
#define DEFAULT_NUM_BARS 100
#define DEFAULT_FPS 60
#define MIN_FREQ 40.0f
#define MAX_FREQ_CAP 16000.0f

static volatile sig_atomic_t g_quit = 0;

static void handle_sigint(int sig)
{
    (void)sig;
    g_quit = 1;
}

// strcasecmp
static int streq_ci(const char *a, const char *b)
{
    while (*a && *b)
    {
        if (tolower((unsigned char)*a) != tolower((unsigned char)*b))
            return 0;
        a++;
        b++;
    }
    return *a == *b;
}

// can take gradient name or index
static int parse_gradient(const char *arg)
{
    for (int i = 0; i < render_gradient_count(); i++)
    {
        if (streq_ci(arg, render_gradient_name(i)))
            return i;
    }
    char *end = NULL;
    long n = strtol(arg, &end, 10);
    if (end != arg && *end == '\0' && n >= 0 && n < render_gradient_count())
    {
        return (int)n;
    }
    return -1;
}

static void print_usage(const char *prog)
{
    printf("Usage: %s [OPTIONS]\n\n", prog);
    printf("  -d, --device NAME     pulse source to grab (default: auto monitor of default sink)\n");
    printf("  -b, --bars N          how many bars to draw (default: %d)\n", DEFAULT_NUM_BARS);
    printf("  -s, --sensitivity F   gain multiplier on bar height (default: 1.0)\n");
    printf("  -g, --gradient NAME   color gradient, name or index (default: %s) -- options: ",
           render_gradient_name(0));
    for (int i = 0; i < render_gradient_count(); i++)
    {
        printf("%s%s", i == 0 ? "" : ", ", render_gradient_name(i));
    }
    printf("\n  -f, --font PATH      .ttf to draw the top-right label (default: %s)\n", DEFAULT_FONT_PATH);
    printf("\n");
    printf("      --fps N           target frame rate (default: %d)\n", DEFAULT_FPS);
    printf("      --list-devices    print pulse sources and exit\n");
    printf("  -h, --help            print this and exit\n\n");
    printf("Keys while running: SPACE toggle bars/waveform, G cycle gradient, ESC or q quit.\n");
    printf("Top-right corner shows the current gradient name -- font missing just means no label, nothing else breaks.\n");
}

static int load_best_font(TTF_Font **font, const char *user_path)
{
    if (user_path)
    {
        return (render_font_load(font, user_path, DEFAULT_FONT_SIZE));
    }

    const char *appdir = getenv("APPDIR"); // only when launching AppImage
    if (appdir)
    {
        char bundled[512];
        snprintf(bundled, sizeof(bundled), "%s/usr/share/fonts/mola/%s", appdir, BUNDLED_FONT_NAME);
        if (render_font_load(font, bundled, DEFAULT_FONT_SIZE) == 0)
            return (0);
    }

    return (render_font_load(font, DEFAULT_FONT_PATH, DEFAULT_FONT_SIZE));
}

int main(int argc, char **argv)
{
    const char *device = NULL;
    int num_bars = DEFAULT_NUM_BARS;
    float sensitivity = 0.05f;
    int target_fps = DEFAULT_FPS;
    int gradient = 0;
    const char *font_path = DEFAULT_FONT_PATH;
    int font_from_user = 0;

    for (int i = 1; i < argc; i++)
    {
        if ((strcmp(argv[i], "-d") == 0 || strcmp(argv[i], "--device") == 0) && i + 1 < argc)
        {
            device = argv[++i];
        }
        else if ((strcmp(argv[i], "-b") == 0 || strcmp(argv[i], "--bars") == 0) && i + 1 < argc)
        {
            num_bars = atoi(argv[++i]);
        }
        else if ((strcmp(argv[i], "-s") == 0 || strcmp(argv[i], "--sensitivity") == 0) && i + 1 < argc)
        {
            sensitivity = (float)atof(argv[++i]);
        }
        else if ((strcmp(argv[i], "-g") == 0 || strcmp(argv[i], "--gradient") == 0) && i + 1 < argc)
        {
            int g = parse_gradient(argv[++i]);
            if (g < 0)
            {
                fprintf(stderr, "unknown gradient '%s'\n\n", argv[i]);
                print_usage(argv[0]);
                return 1;
            }
            gradient = g;
        }
        else if (strcmp(argv[i], "--fps") == 0 && i + 1 < argc)
        {
            target_fps = atoi(argv[++i]);
        }
        else if (strcmp(argv[i], "--list-devices") == 0)
        {
            audio_print_sources();
            return 0;
        }
        else if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0)
        {
            print_usage(argv[0]);
            return 0;
        }
        else if ((strcmp(argv[i], "-f") == 0 || strcmp(argv[i], "--font") == 0) && i + 1 < argc)
        {
            font_path = argv[++i];
            font_from_user = 1;
        }
        else
        {
            fprintf(stderr, "unknown flag: %s\n\n", argv[i]);
            print_usage(argv[0]);
            return 1;
        }
    }

    if (num_bars <= 0)
    {
        fprintf(stderr, "bar count must be positive, got %d\n", num_bars);
        return 1;
    }
    if (target_fps <= 0)
        target_fps = DEFAULT_FPS;
    if (sensitivity <= 0.0f)
        sensitivity = 0.05f;

    signal(SIGINT, handle_sigint);

    int exit_code = 0;

    AudioCapture cap;
    memset(&cap, 0, sizeof(cap));
    int cap_started = 0;

    SDL_Window *win = NULL;
    SDL_Renderer *ren = NULL;
    int sdl_started = 0;

    BarMapper bars;
    memset(&bars, 0, sizeof(bars));
    int bars_ready = 0;

    TTF_Font *font = NULL;
    int font_ready = 0;
    Label label;
    memset(&label, 0, sizeof(label));

    float *samples = NULL;
    float *windowed = NULL;
    Complex *spectrum = NULL;
    float *magnitudes = NULL;

    if (audio_capture_start(&cap, device, DEFAULT_SAMPLE_RATE) != 0)
    {
        fprintf(stderr, "could not grab sound from pulse/pipewire. is a sound server awake?\n");
        fprintf(stderr, "try --list-devices to see sources, or --device NAME to pick one by hand.\n");
        exit_code = 1;
        goto cleanup;
    }
    cap_started = 1;

    if (render_init(&win, &ren, 1000, 500, "Mola") != 0)
    {
        exit_code = 1;
        goto cleanup;
    }
    sdl_started = 1;

    if (load_best_font(&font, font_from_user ? font_path : NULL) == 0)
    {
        font_ready = 1;
    }
    else
    {
        fprintf(stderr, "no label can be displayed without a font -- try --font PATH to point at one you have.\n");
    }

    {
        float nyquist = (float)DEFAULT_SAMPLE_RATE / 2.0f;
        float max_freq = (MAX_FREQ_CAP < nyquist) ? MAX_FREQ_CAP : nyquist * 0.95f;
        if (bars_init(&bars, num_bars, FFT_SIZE, DEFAULT_SAMPLE_RATE, MIN_FREQ, max_freq) != 0)
        {
            fprintf(stderr, "out of memory setting up the bar map\n");
            exit_code = 1;
            goto cleanup;
        }
        bars_ready = 1;
    }

    samples = malloc(sizeof(float) * FFT_SIZE);
    windowed = malloc(sizeof(float) * FFT_SIZE);
    spectrum = malloc(sizeof(Complex) * FFT_SIZE);
    magnitudes = malloc(sizeof(float) * (FFT_SIZE / 2));
    if (!samples || !windowed || !spectrum || !magnitudes)
    {
        fprintf(stderr, "out of memory allocating audio buffers\n");
        exit_code = 1;
        goto cleanup;
    }

    {
        VisMode mode = VIS_MODE_BARS;
        int win_w = 1000, win_h = 500;
        Uint32 frame_delay = 1000u / (Uint32)target_fps;

        while (!g_quit)
        {
            Uint32 frame_start = SDL_GetTicks();

            SDL_Event e;
            while (SDL_PollEvent(&e))
            {
                if (e.type == SDL_QUIT)
                {
                    g_quit = 1;
                }
                else if (e.type == SDL_WINDOWEVENT && e.window.event == SDL_WINDOWEVENT_RESIZED)
                {
                    win_w = e.window.data1;
                    win_h = e.window.data2;
                }
                else if (e.type == SDL_KEYDOWN)
                {
                    SDL_Keycode k = e.key.keysym.sym;
                    if (k == SDLK_ESCAPE || k == SDLK_q)
                    {
                        g_quit = 1;
                    }
                    else if (k == SDLK_SPACE)
                    {
                        mode = (mode == VIS_MODE_BARS) ? VIS_MODE_WAVE : VIS_MODE_BARS;
                    }
                    else if (k == SDLK_g)
                    {
                        gradient = (gradient + 1) % render_gradient_count();
                    }
                }
            }

            audio_capture_get_window(&cap, samples, FFT_SIZE);

            memcpy(windowed, samples, sizeof(float) * FFT_SIZE);
            fft_apply_hann_window(windowed, FFT_SIZE);
            for (int i = 0; i < FFT_SIZE; i++)
            {
                spectrum[i].re = windowed[i];
                spectrum[i].im = 0.0f;
            }
            fft_forward(spectrum, FFT_SIZE);
            for (int i = 0; i < FFT_SIZE / 2; i++)
            {
                float re = spectrum[i].re;
                float im = spectrum[i].im;
                magnitudes[i] = sqrtf(re * re + im * im);
            }
            bars_update(&bars, magnitudes, sensitivity, 0.7f, 0.1f);

            if (mode == VIS_MODE_BARS)
            {
                render_draw_bars(ren, bars.smoothed, bars.count, win_w, win_h, gradient);
            }
            else
            {
                render_draw_waveform(ren, samples, FFT_SIZE, win_w, win_h, gradient);
            }

            if (font_ready)
            {
                char label_text[64];
                snprintf(label_text, sizeof(label_text), "%s -- (G to change)", render_gradient_name(gradient));
                render_update_label(ren, font, &label, label_text);
                render_draw_label(ren, &label, win_w, 12);
            }

            SDL_RenderPresent(ren);

            Uint32 elapsed = SDL_GetTicks() - frame_start;
            if (elapsed < frame_delay)
            {
                SDL_Delay(frame_delay - elapsed);
            }
        }
    }

cleanup:
    free(samples);
    free(windowed);
    free(spectrum);
    free(magnitudes);
    if (bars_ready)
        bars_free(&bars);
    render_label_free(&label);
    if (font_ready)
        render_font_free(font);
    if (sdl_started)
    {
        SDL_DestroyRenderer(ren);
        SDL_DestroyWindow(win);
        SDL_Quit();
    }
    if (cap_started)
        audio_capture_stop(&cap);

    return exit_code;
}
