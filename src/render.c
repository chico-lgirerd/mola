#include "render.h"

#include <stdio.h>
#include <stdlib.h>

int render_init(SDL_Window **win, SDL_Renderer **ren, int width, int height, const char *title)
{
    if (SDL_Init(SDL_INIT_VIDEO) != 0)
    {
        fprintf(stderr, "SDL would not wake up: %s\n", SDL_GetError());
        return -1;
    }

    // SDL_EnableScreenSaver(); this doesn't seem to work even when enable, keeps screen awake

    *win = SDL_CreateWindow(title, SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                            width, height, SDL_WINDOW_RESIZABLE);
    if (!*win)
    {
        fprintf(stderr, "SDL could not build a window: %s\n", SDL_GetError());
        return -1;
    }

    *ren = SDL_CreateRenderer(*win, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
    if (!*ren)
    {
        *ren = SDL_CreateRenderer(*win, -1, SDL_RENDERER_SOFTWARE); // no hardware acceleration fallback
    }
    if (!*ren)
    {
        fprintf(stderr, "SDL could not build a renderer: %s\n", SDL_GetError());
        return -1;
    }

    return 0;
}

typedef struct
{
    const char *name;
    Uint8 lo[3];
    Uint8 hi[3];
} Gradient;

static const Gradient GRADIENTS[] = {
    {"dusk", {70, 60, 140}, {255, 170, 80}},
    {"ocean", {20, 40, 90}, {80, 220, 220}},
    {"ember", {90, 20, 20}, {255, 200, 60}},
    {"mono", {55, 55, 60}, {235, 235, 240}},
    {"synth", {80, 20, 120}, {255, 90, 180}},
    {"citrus", {220, 110, 20}, {80, 200, 90}},
    {"lagoon", {30, 170, 170}, {150, 60, 200}},
    {"solaris", {180, 30, 40}, {40, 210, 220}},
    {"tropic", {220, 30, 140}, {170, 220, 40}},
};
#define GRADIENT_COUNT ((int)(sizeof(GRADIENTS) / sizeof(GRADIENTS[0])))

int render_gradient_count(void)
{
    return GRADIENT_COUNT;
}

const char *render_gradient_name(int index)
{
    if (index < 0 || index >= GRADIENT_COUNT)
        index = 0;
    return GRADIENTS[index].name;
}

static const Gradient *gradient_lookup(int index)
{
    if (index < 0 || index >= GRADIENT_COUNT)
        index = 0; // bad index, don't crash, just use default
    return &GRADIENTS[index];
}

static void lerp_color(Uint8 *r, Uint8 *g, Uint8 *b, const Gradient *grad, float t)
{
    if (t < 0.0f)
        t = 0.0f;
    if (t > 1.0f)
        t = 1.0f;
    *r = (Uint8)(grad->lo[0] + (grad->hi[0] - grad->lo[0]) * t);
    *g = (Uint8)(grad->lo[1] + (grad->hi[1] - grad->lo[1]) * t);
    *b = (Uint8)(grad->lo[2] + (grad->hi[2] - grad->lo[2]) * t);
}

void render_draw_bars(SDL_Renderer *ren, const float *values, int count, int win_w, int win_h, int gradient)
{
    const Gradient *grad = gradient_lookup(gradient);

    SDL_SetRenderDrawColor(ren, 8, 8, 14, 255);
    SDL_RenderClear(ren);

    if (count > 0)
    {
        float gap = 2.0f;
        float bar_w = ((float)win_w - gap * (float)(count + 1)) / (float)count;
        if (bar_w < 1.0f)
            bar_w = 1.0f;

        for (int i = 0; i < count; i++)
        {
            float v = values[i];
            if (v < 0.0f)
                v = 0.0f;
            if (v > 1.0f)
                v = 1.0f;

            float bar_h = v * (float)win_h * 0.95f;
            float x = gap + (float)i * (bar_w + gap);
            float y = (float)win_h - bar_h;

            Uint8 r, g, b;
            lerp_color(&r, &g, &b, grad, v);
            SDL_SetRenderDrawColor(ren, r, g, b, 255);

            SDL_Rect rect = {(int)x, (int)y, (int)bar_w, (int)bar_h + 1};
            SDL_RenderFillRect(ren, &rect);
        }
    }
}

void render_draw_waveform(SDL_Renderer *ren, const float *samples, int count, int win_w, int win_h, int gradient)
{
    const Gradient *grad = gradient_lookup(gradient);

    SDL_SetRenderDrawColor(ren, 8, 8, 14, 255);
    SDL_RenderClear(ren);

    if (count > 1)
    {
        SDL_Point *pts = (SDL_Point *)malloc(sizeof(SDL_Point) * (size_t)count);
        if (pts)
        {
            int mid = win_h / 2;
            for (int i = 0; i < count; i++)
            {
                float x = (float)win_w * (float)i / (float)(count - 1);
                float y = (float)mid - samples[i] * (float)mid * 0.9f;
                pts[i].x = (int)x;
                pts[i].y = (int)y;
            }
            SDL_SetRenderDrawColor(ren, grad->hi[0], grad->hi[1], grad->hi[2], 255);
            SDL_RenderDrawLines(ren, pts, count);
            free(pts);
        }
        // if malloc fail, only skip line, no crash
    }
}

void render_draw_bezier(SDL_Renderer *ren, const float *values, int count, int win_w, int win_h, int gradient)
{
    const Gradient *grad = gradient_lookup(gradient);

    SDL_SetRenderDrawColor(ren, 8, 8, 14, 255);
    SDL_RenderClear(ren);

    if (count < 2 || win_w <= 0)
        return;

    float *ctrl_x = malloc(sizeof(float) * (size_t)count);
    float *ctrl_y = malloc(sizeof(float) * (size_t)count);
    if (!ctrl_x || !ctrl_y)
    {
        free(ctrl_x);
        free(ctrl_y);
        return;
    }

    for (int i = 0; i < count; i++)
    {
        float v = values[i];
        if (v < 0.0f)
            v = 0.0f;
        if (v > 1.0f)
            v = 1.0f;
        ctrl_x[i] = (count > 1) ? (float)i * (float)(win_w - 1) / (float)(count - 1) : 0.0f;
        ctrl_y[i] = (float)win_h - v * (float)win_h * 0.9f;
    }

    float *smooth_y = malloc(sizeof(float) * (size_t)count);
    if (!smooth_y)
    {
        free(ctrl_x);
        free(ctrl_y);
        return;
    }

    static const float kernel[7] = {0.05f, 0.1f, 0.2f, 0.3f, 0.2f, 0.1f, 0.05f};
    for (int i = 0; i < count; i++)
    {
        float sum = 0.0f;
        for (int k = -3; k <= 3; k++)
        {
            int idx = i + k;
            if (idx < 0)
                idx = 0;
            if (idx >= count)
                idx = count - 1;
            sum += ctrl_y[idx] * kernel[k + 3];
        }
        smooth_y[i] = sum;
    }
    memcpy(ctrl_y, smooth_y, sizeof(float) * (size_t)count);
    free(smooth_y);

    int max_pts = 2 + (count - 1) * 80;
    float *px_arr = malloc(sizeof(float) * (size_t)max_pts);
    float *py_arr = malloc(sizeof(float) * (size_t)max_pts);
    float *curve_y = malloc(sizeof(float) * (size_t)win_w);
    if (!px_arr || !py_arr || !curve_y)
    {
        free(ctrl_x);
        free(ctrl_y);
        free(px_arr);
        free(py_arr);
        free(curve_y);
        return;
    }

    int npts = 0;
    px_arr[npts] = ctrl_x[0];
    py_arr[npts] = ctrl_y[0];
    npts++;

    for (int i = 0; i < count - 1; i++)
    {
        float p0x = (i == 0) ? ctrl_x[0] : ctrl_x[i - 1];
        float p0y = (i == 0) ? ctrl_y[0] : ctrl_y[i - 1];
        float p1x = ctrl_x[i], p1y = ctrl_y[i];
        float p2x = ctrl_x[i + 1], p2y = ctrl_y[i + 1];
        float p3x = (i + 2 < count) ? ctrl_x[i + 2] : ctrl_x[count - 1];
        float p3y = (i + 2 < count) ? ctrl_y[i + 2] : ctrl_y[count - 1];

        float c1x, c1y, c2x, c2y;
        catmull_to_bezier(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y, &c1x, &c1y, &c2x, &c2y);

        int seg_px = (int)(p2x - p1x);
        int steps = seg_px / 3;
        if (steps < 8)
            steps = 8;
        if (steps > 80)
            steps = 80;

        for (int s = 1; s <= steps && npts < max_pts; s++)
        {
            float t = (float)s / (float)steps;
            float x, y;
            bezier_eval(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, t, &x, &y);
            px_arr[npts] = x;
            py_arr[npts] = y;
            npts++;
        }
    }

    int j = 0;
    for (int x = 0; x < win_w; x++)
    {
        float fx = (float)x;
        while (j + 1 < npts - 1 && px_arr[j + 1] < fx)
            j++;

        float x0 = px_arr[j], y0 = py_arr[j];
        float x1 = px_arr[j + 1], y1 = py_arr[j + 1];

        if (fx <= x0)
            curve_y[x] = y0;
        else if (fx >= x1)
            curve_y[x] = y1;
        else
            curve_y[x] = y0 + (y1 - y0) * (fx - x0) / (x1 - x0);
    }

    SDL_SetRenderDrawBlendMode(ren, SDL_BLENDMODE_BLEND);

    for (int x = 0; x < win_w; x++)
    {
        float y = curve_y[x];
        float v = ((float)win_h - y) / ((float)win_h * 0.9f);
        Uint8 r, g, b;
        lerp_color(&r, &g, &b, grad, v);
        SDL_SetRenderDrawColor(ren, r, g, b, 90);
        SDL_RenderDrawLine(ren, x, (int)y, x, win_h);
    }

    for (int x = 1; x < win_w; x++)
    {
        float v = ((float)win_h - curve_y[x]) / ((float)win_h * 0.9f);
        Uint8 r, g, b;
        lerp_color(&r, &g, &b, grad, v);
        SDL_SetRenderDrawColor(ren, r, g, b, 255);
        SDL_RenderDrawLine(ren, x - 1, (int)curve_y[x - 1], x, (int)curve_y[x]);
        SDL_RenderDrawLine(ren, x - 1, (int)curve_y[x - 1] + 1, x, (int)curve_y[x] + 1);
    }

    SDL_SetRenderDrawBlendMode(ren, SDL_BLENDMODE_NONE);

    free(ctrl_x);
    free(ctrl_y);
    free(px_arr);
    free(py_arr);
    free(curve_y);
}

int render_font_load(TTF_Font **font, const char *path, int pt_size)
{
    if (TTF_Init() != 0)
    {
        fprintf(stderr, "SDL_ttf would not wake up: %s\n", TTF_GetError());
        return (-1);
    }

    *font = TTF_OpenFont(path, pt_size);

    if (!*font)
    {
        fprintf(stderr, "SDL_ttf could not load font: %s\n", TTF_GetError());
        TTF_Quit();
        return (-1);
    }

    return (0);
}

void render_font_free(TTF_Font *font)
{
    if (font)
        TTF_CloseFont(font);
    TTF_Quit();
}

void render_update_label(SDL_Renderer *ren, TTF_Font *font, Label *label, const char *text)
{
    if (!font || !text)
        return;

    // text not changed so no redraw
    if (strncmp(label->cached_text, text, sizeof(label->cached_text)) == 0)
        return;

    if (label->texture)
    {
        SDL_DestroyTexture(label->texture);
        label->texture = NULL;
    }

    SDL_Color color = {230, 230, 235, 255};
    SDL_Surface *surface = TTF_RenderUTF8_Blended(font, text, color);

    if (!surface)
    {
        fprintf(stderr, "could not render label text: %s\n", TTF_GetError());
        label->cached_text[0] = '\0';
        return;
    }

    label->texture = SDL_CreateTextureFromSurface(ren, surface);
    label->w = surface->w;
    label->h = surface->h;
    SDL_FreeSurface(surface);

    if (!label->texture)
    {
        fprintf(stderr, "could not upload label texture: %s\n", SDL_GetError());
        label->cached_text[0] = '\0';
        return;
    }

    strncpy(label->cached_text, text, sizeof(label->cached_text) - 1);
    label->cached_text[sizeof(label->cached_text) - 1] = '\0';
}

void render_draw_label(SDL_Renderer *ren, const Label *label, int win_w, int pad)
{
    if (!label->texture)
        return;

    SDL_Rect dest = {win_w - label->w - pad, pad, label->w, label->h};
    SDL_RenderCopy(ren, label->texture, NULL, &dest);
}

void render_label_free(Label *label)
{
    if (label->texture)
    {
        SDL_DestroyTexture(label->texture);
        label->texture = NULL;
    }
}