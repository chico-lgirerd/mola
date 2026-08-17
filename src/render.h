#ifndef RENDER_H
#define RENDER_H

#include <SDL2/SDL.h>
#include <SDL2/SDL_ttf.h>

typedef enum
{
    VIS_MODE_BARS = 0,
    VIS_MODE_WAVE = 1,
    VIS_MODE_BEZIER = 2
} VisMode;

typedef struct
{
    SDL_Texture *texture;
    int w, h;
    char cached_text[64];
} Label;

/* Wake up SDL, build a resizable window + renderer. Returns 0 on ok. */
int render_init(SDL_Window **win, SDL_Renderer **ren, int width, int height, const char *title);

/* how many named gradients exist, and what index 0..count-1 is called.
 * out-of-range index just falls back to gradient 0 rather than crashing. */
int render_gradient_count(void);
const char *render_gradient_name(int index);

/* values are eased bar heights in [0,1], count of them. gradient picks
 * the low->high color pair from render_gradient_name's table. */
void render_draw_bars(SDL_Renderer *ren, const float *values, int count, int win_w, int win_h, int gradient);

/* samples are raw (unwindowed) mono audio in roughly [-1,1]. line color
 * comes from the gradient's high-end color, so waveform matches bars. */
void render_draw_waveform(SDL_Renderer *ren, const float *samples, int count, int win_w, int win_h, int gradient);

void catmull_to_bezier(float p0x, float p0y, float p1x, float p1y,
                              float p2x, float p2y, float p3x, float p3y,
                              float *c1x, float *c1y, float *c2x, float *c2y);

void bezier_eval(float p0x, float p0y, float c1x, float c1y,
                        float c2x, float c2y, float p1x, float p1y,
                        float t, float *outx, float *outy);

void render_draw_bezier(SDL_Renderer *ren, const float *values, int count, int win_w, int win_h, int gradient);

int render_font_load(TTF_Font **font, const char *path, int pt_size);
void render_font_free(TTF_Font *font);

void render_update_label(SDL_Renderer *ren, TTF_Font *font, Label *label, const char *text);
void render_draw_label(SDL_Renderer *ren, const Label *label, int win_w, int pad);

void render_label_free(Label *label);

#endif
