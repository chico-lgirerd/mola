#include "render.h"

void catmull_to_bezier(float p0x, float p0y, float p1x, float p1y,
															float p2x, float p2y, float p3x, float p3y,
															float *c1x, float *c1y, float *c2x, float *c2y)
{
	*c1x = p1x + (p2x - p0x) / 6.0f;
	*c1y = p1y + (p2y - p0y) / 6.0f;
	*c2x = p2x + (p3x - p1x) / 6.0f;
	*c2y = p2y + (p3y - p1y) / 6.0f;
}

void bezier_eval(float p0x, float p0y, float c1x, float c1y,
												float c2x, float c2y, float p1x, float p1y,
												float t, float *outx, float *outy)
{
	float u = 1.0f - t;
	float uu = u * u;
	float tt = t * t;
	float uuu = uu * u;
	float ttt = tt * t;

	*outx = uuu * p0x + 3.0f * uu * t * c1x + 3.0f * u * tt * c2x + ttt * p1x;
	*outy = uuu * p0y + 3.0f * uu * t * c1y + 3.0f * u * tt * c2y + ttt * p1y;
}